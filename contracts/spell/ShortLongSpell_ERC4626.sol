// SPDX-License-Identifier: MIT
/*
██████╗ ██╗     ██╗   ██╗███████╗██████╗ ███████╗██████╗ ██████╗ ██╗   ██╗
██╔══██╗██║     ██║   ██║██╔════╝██╔══██╗██╔════╝██╔══██╗██╔══██╗╚██╗ ██╔╝
██████╔╝██║     ██║   ██║█████╗  ██████╔╝█████╗  ██████╔╝██████╔╝ ╚████╔╝
██╔══██╗██║     ██║   ██║██╔══╝  ██╔══██╗██╔══╝  ██╔══██╗██╔══██╗  ╚██╔╝
██████╔╝███████╗╚██████╔╝███████╗██████╔╝███████╗██║  ██║██║  ██║   ██║
╚═════╝ ╚══════╝ ╚═════╝ ╚══════╝╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝
*/

pragma solidity 0.8.22;
import "hardhat/console.sol";
import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import { PSwapLib } from "../libraries/Paraswap/PSwapLib.sol";
import { UniversalERC20, IERC20 } from "../libraries/UniversalERC20.sol";

import "../utils/BlueberryErrors.sol" as Errors;

import { BasicSpell } from "./BasicSpell.sol";

import { IBank } from "../interfaces/IBank.sol";
import { IWERC20 } from "../interfaces/IWERC20.sol";
import { IWERC4626 } from "../interfaces/IWERC4626.sol";
import { ISoftVault } from "../interfaces/ISoftVault.sol";
import { IShortLongSpell } from "../interfaces/spell/IShortLongSpell.sol";

/**
 * @title Short/Long Spell
 * @author BlueberryProtocol
 * @notice Short/Long Spell is the factory contract that
 *          defines how Blueberry Protocol interacts for leveraging
 *          an asset either long or short
 */
contract ShortLongSpell_ERC4626 is IShortLongSpell, BasicSpell {
    using SafeCast for uint256;
    using SafeCast for int256;
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using UniversalERC20 for IERC20;

    mapping(address => IWERC4626) public borrowTokenToWrapper;

    /*//////////////////////////////////////////////////////////////////////////
                                     CONSTRUCTOR
    //////////////////////////////////////////////////////////////////////////*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /*//////////////////////////////////////////////////////////////////////////
                                      FUNCTIONS
    //////////////////////////////////////////////////////////////////////////*/

    /**
     * @notice Initializes the contract
     * @param bank The bank interface
     * @param werc20 Wrapped ERC20 interface
     * @param weth Wrapped Ether address
     * @param augustusSwapper Augustus Swapper address
     * @param tokenTransferProxy Token Transfer Proxy address
     * @param owner Address of the owner
     */
    function initialize(
        IBank bank,
        address werc20,
        address weth,
        address augustusSwapper,
        address tokenTransferProxy,
        address owner
    ) external initializer {
        if (augustusSwapper == address(0)) revert Errors.ZERO_ADDRESS();
        if (tokenTransferProxy == address(0)) revert Errors.ZERO_ADDRESS();

        _augustusSwapper = augustusSwapper;
        _tokenTransferProxy = tokenTransferProxy;

        __BasicSpell_init(bank, werc20, weth, augustusSwapper, tokenTransferProxy, owner);
    }

    /// @inheritdoc IShortLongSpell
    function openPosition(
        OpenPosParam calldata param,
        bytes calldata swapData
    ) external existingStrategy(param.strategyId) existingCollateral(param.strategyId, param.collToken) {
        Strategy memory strategy = _strategies[param.strategyId];
        address wrapper = address(borrowTokenToWrapper[IERC4626(strategy.vault).asset()]);

        // swap token cannot be borrow token
        if (address(IWERC4626(wrapper).getUnderlyingToken().asset()) == param.borrowToken) {
            revert Errors.INCORRECT_LP(param.borrowToken);
        }

        /// 1-3 Swap to strategy underlying token, deposit to soft vault
        uint256 swapTokenAmt = _deposit(param, swapData);

        /// 4. Put collateral - strategy token
        _doPutCollateral(wrapper, swapTokenAmt);
    }

    /// @inheritdoc IShortLongSpell
    function closePosition(
        ClosePosParam calldata param,
        bytes calldata swapData
    ) external existingStrategy(param.strategyId) existingCollateral(param.strategyId, param.collToken) {
        IBank bank = getBank();
        Strategy memory strategy = _strategies[param.strategyId];
        address wrapper = address(borrowTokenToWrapper[IERC4626(strategy.vault).asset()]);

        IBank.Position memory pos = bank.getCurrentPositionInfo();
        address posCollToken = pos.collToken;
        uint256 collId = pos.collId;

        if (posCollToken != wrapper) revert Errors.INCORRECT_COLTOKEN(posCollToken);
        if (address(IWERC4626(posCollToken).getUnderlyingToken()) != address(IWERC4626(wrapper).getUnderlyingToken()))
            revert Errors.INCORRECT_UNDERLYING(wrapper);

        /// 1-7. Remove liquidity
        _withdraw(param, swapData);
    }

    /// @inheritdoc IShortLongSpell
    function addStrategy(address wrapper,  uint256 minCollSize, uint256 maxPosSize) external onlyOwner {//todo
        IERC4626 underlyingToken = IWERC4626(wrapper).getUnderlyingToken();
        borrowTokenToWrapper[underlyingToken.asset()] = IWERC4626(wrapper);
        _addStrategy(address(underlyingToken), minCollSize, maxPosSize);
    }

    /**
     * @notice Internal function to swap token using paraswap assets
     * @dev Deposit isolated underlying to Blueberry Money Market,
     *      Borrow tokens from Blueberry Money Market,
     *      Swap borrowed token to another token
     * @param param Parameters for opening position
     * @dev params found in OpenPosParam struct in {BasicSpell}
     * @param swapData Data for paraswap swap
     * @dev swapData found in bytes struct in {PSwapLib}
     */
    function _deposit(OpenPosParam calldata param, bytes calldata swapData) internal returns(uint256) {
        Strategy memory strategy = _strategies[param.strategyId];

        /// 1. Deposit isolated collaterals on Blueberry Money Market
        _doLend(param.collToken, param.collAmount);

        /// 2. Borrow specific amounts
        _doBorrow(param.borrowToken, param.borrowAmount);

        /// 3. Swap borrowed token to strategy token
        IERC20Upgradeable swapToken = IERC20Upgradeable(IERC4626(strategy.vault).asset());
        uint256 swapTokenAmt = swapToken.balanceOf(address(this));

        address borrowToken = param.borrowToken;
        if (!PSwapLib.swap(_augustusSwapper, _tokenTransferProxy, borrowToken, param.borrowAmount, swapData)) {
            revert Errors.SWAP_FAILED(borrowToken);
        }

        swapTokenAmt = swapToken.balanceOf(address(this)) - swapTokenAmt;
        if (swapTokenAmt == 0) revert Errors.SWAP_FAILED(borrowToken);

        /// 5. Validate MAX LTV
        _validateMaxLTV(param.strategyId);

        /// 6. Validate Max Pos Size
        _validatePosSize(param.strategyId);
        return swapTokenAmt;
    }

    /**
     * @notice Internal utility function to handle the withdrawal of assets from SoftVault.
     * @param param Parameters required for the withdrawal, described in the `ClosePosParam` struct.
     * @param swapData Specific data needed for the ParaSwap swap.
     */
    function _withdraw(ClosePosParam calldata param, bytes calldata swapData) internal {
        Strategy memory strategy = _strategies[param.strategyId];
        IWERC4626 wrapper = borrowTokenToWrapper[IERC4626(strategy.vault).asset()]; //IWERC4626(strategy.vault); //todo

        IBank bank = getBank();
        IBank.Position memory pos = bank.getCurrentPositionInfo();
        uint256 positionId = bank.POSITION_ID();

        /// 1. Take out collateral
        uint256 burnAmount = bank.takeCollateral(param.amountPosRemove);

        /// 2. Withdraw from wrapper
        // we retrieved pxETH back from the apxETh contract
        uint256 swapAmount = IWERC4626(wrapper).burn(pos.collId, burnAmount);

        /// 3. Swap strategy token to isolated collateral token
        {
            IERC20Upgradeable uToken = IERC20Upgradeable(IERC4626(strategy.vault).asset()); //wrapper.getUnderlyingToken(); //todo
            uint256 balanceBefore = uToken.balanceOf(address(this));

            //we swapped pxETH for CRV
            if (!PSwapLib.swap(_augustusSwapper, _tokenTransferProxy, address(uToken), swapAmount, swapData))
                revert Errors.SWAP_FAILED(address(uToken));

            if (uToken.balanceOf(address(this)) > balanceBefore - swapAmount) {
                revert Errors.INCORRECT_LP(address(uToken));
            }
        }


        /// 5. Swap some collateral to repay debt(for negative PnL)
        _swapCollToDebt(param.collToken, param.amountToSwap, param.swapData);


        /// 6. Repay
        {
            uint256 borrowTokenBal = IERC20Upgradeable(param.borrowToken).balanceOf(address(this));
            uint256 amountRepay = param.amountRepay;

            if (amountRepay == type(uint256).max) {
                amountRepay = bank.currentPositionDebt(positionId);
            }

            if(amountRepay > borrowTokenBal){
                amountRepay = borrowTokenBal;
            }

            _doRepay(param.borrowToken, amountRepay);
        }

        _validateMaxLTV(param.strategyId);

        /// 7. Refund
        _doRefund(param.borrowToken);
        _doRefund(param.collToken);
    }

    /**
     * @inheritdoc BasicSpell
     */
    function _doPutCollateral(address wrapper, uint256 amount) internal override {
        if (amount > 0) {
            /// 4. Deposit to SoftVault directly
            IERC4626 underlyingToken = IWERC4626(wrapper).getUnderlyingToken();
            IERC20(underlyingToken.asset()).universalApprove(address(wrapper), amount);
            uint id = IWERC4626(wrapper).mint(amount);

            _bank.putCollateral(address(wrapper), id, amount);
        }
    }
}
