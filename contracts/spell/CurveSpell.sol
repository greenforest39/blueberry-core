// SPDX-License-Identifier: MIT
/*
██████╗ ██╗     ██╗   ██╗███████╗██████╗ ███████╗██████╗ ██████╗ ██╗   ██╗
██╔══██╗██║     ██║   ██║██╔════╝██╔══██╗██╔════╝██╔══██╗██╔══██╗╚██╗ ██╔╝
██████╔╝██║     ██║   ██║█████╗  ██████╔╝█████╗  ██████╔╝██████╔╝ ╚████╔╝
██╔══██╗██║     ██║   ██║██╔══╝  ██╔══██╗██╔══╝  ██╔══██╗██╔══██╗  ╚██╔╝
██████╔╝███████╗╚██████╔╝███████╗██████╔╝███████╗██║  ██║██║  ██║   ██║
╚═════╝ ╚══════╝ ╚═════╝ ╚══════╝╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝
*/

pragma solidity 0.8.16;

import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import "./BasicSpell.sol";
import "../interfaces/ICurveOracle.sol";
import "../interfaces/IWCurveGauge.sol";
import "../interfaces/curve/ICurvePool.sol";
import "../interfaces/uniswap/IUniswapV2Router02.sol";

/**
 * @title CurveSpell
 * @author BlueberryProtocol
 * @notice CurveSpell is the factory contract that
 * defines how Blueberry Protocol interacts with Curve pools
 */
contract CurveSpell is BasicSpell {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @dev address of Wrapped Curve Gauge
    IWCurveGauge public wCurveGauge;
    /// @dev address of CurveOracle
    ICurveOracle public crvOracle;
    /// @dev address of CRV token
    address public CRV;

    function initialize(
        IBank bank_,
        address werc20_,
        address weth_,
        address wCurveGauge_,
        address crvOracle_
    ) external initializer {
        __BasicSpell_init(bank_, werc20_, weth_);
        if (wCurveGauge_ == address(0) || crvOracle_ == address(0))
            revert Errors.ZERO_ADDRESS();

        wCurveGauge = IWCurveGauge(wCurveGauge_);
        CRV = address(wCurveGauge.CRV());
        crvOracle = ICurveOracle(crvOracle_);
        IWCurveGauge(wCurveGauge_).setApprovalForAll(address(bank_), true);
    }

    /**
     * @notice Add strategy to the spell
     * @param crvLp Address of crv lp token for given strategy
     * @param minPosSize, USD price of minimum position size for given strategy, based 1e18
     * @param maxPosSize, USD price of maximum position size for given strategy, based 1e18
     */
    function addStrategy(
        address crvLp,
        uint256 minPosSize,
        uint256 maxPosSize
    ) external onlyOwner {
        _addStrategy(crvLp, minPosSize, maxPosSize);
    }

    /**
     * @notice Add liquidity to Curve pool with 2 underlying tokens, with staking to Curve gauge
     * @param minLPMint Desired LP token amount (slippage control)
     */
    function openPositionFarm(
        OpenPosParam calldata param,
        uint256 minLPMint
    )
        external
        existingStrategy(param.strategyId)
        existingCollateral(param.strategyId, param.collToken)
    {
        address lp = strategies[param.strategyId].vault;
        if (wCurveGauge.getLpFromGaugeId(param.farmingPoolId) != lp)
            revert Errors.INCORRECT_LP(lp);
        (address pool, address[] memory tokens, ) = crvOracle.getPoolInfo(lp);

        // 1. Deposit isolated collaterals on Blueberry Money Market
        _doLend(param.collToken, param.collAmount);

        // 2. Borrow specific amounts
        uint256 borrowBalance = _doBorrow(
            param.borrowToken,
            param.borrowAmount
        );

        // 3. Add liquidity on curve
        address borrowToken = param.borrowToken;
        _ensureApprove(param.borrowToken, pool, borrowBalance);
        if (tokens.length == 2) {
            uint256[2] memory suppliedAmts;
            for (uint256 i = 0; i < 2; i++) {
                if (tokens[i] == borrowToken) {
                    suppliedAmts[i] = IERC20Upgradeable(tokens[i]).balanceOf(
                        address(this)
                    );
                    break;
                }
            }
            ICurvePool(pool).add_liquidity(suppliedAmts, minLPMint);
        } else if (tokens.length == 3) {
            uint256[3] memory suppliedAmts;
            for (uint256 i = 0; i < 3; i++) {
                if (tokens[i] == borrowToken) {
                    suppliedAmts[i] = IERC20Upgradeable(tokens[i]).balanceOf(
                        address(this)
                    );
                    break;
                }
            }
            ICurvePool(pool).add_liquidity(suppliedAmts, minLPMint);
        } else if (tokens.length == 4) {
            uint256[4] memory suppliedAmts;
            for (uint256 i = 0; i < 4; i++) {
                if (tokens[i] == borrowToken) {
                    suppliedAmts[i] = IERC20Upgradeable(tokens[i]).balanceOf(
                        address(this)
                    );
                    break;
                }
            }
            ICurvePool(pool).add_liquidity(suppliedAmts, minLPMint);
        }

        // 4. Validate MAX LTV
        _validateMaxLTV(param.strategyId);

        // 5. Validate Max Pos Size
        _validatePosSize(param.strategyId);

        // 6. Take out collateral and burn
        IBank.Position memory pos = bank.getCurrentPositionInfo();
        if (pos.collateralSize > 0) {
            (uint256 decodedGid, ) = wCurveGauge.decodeId(pos.collId);
            if (param.farmingPoolId != decodedGid)
                revert Errors.INCORRECT_PID(param.farmingPoolId);
            if (pos.collToken != address(wCurveGauge))
                revert Errors.INCORRECT_COLTOKEN(pos.collToken);
            bank.takeCollateral(pos.collateralSize);
            wCurveGauge.burn(pos.collId, pos.collateralSize);
            _doRefundRewards(CRV);
        }

        // 7. Deposit on Curve Gauge, Put wrapped collateral tokens on Blueberry Bank
        uint256 lpAmount = IERC20Upgradeable(lp).balanceOf(address(this));
        _ensureApprove(lp, address(wCurveGauge), lpAmount);
        uint256 id = wCurveGauge.mint(param.farmingPoolId, lpAmount);
        bank.putCollateral(address(wCurveGauge), id, lpAmount);
    }

    function closePositionFarm(
        ClosePosParam calldata param,
        IUniswapV2Router02 swapRouter,
        address[] calldata swapPath,
        bool isKilled,
        address[][] calldata poolTokensSwapPath,
        uint deadline
    )
        external
        existingStrategy(param.strategyId)
        existingCollateral(param.strategyId, param.collToken)
    {
        if (block.timestamp > deadline) revert Errors.EXPIRED(deadline);
        ClosePosParam memory _param = param;
        IUniswapV2Router02 _swapRouter = swapRouter;
        address[] memory _swapPath = swapPath;
        bool _isKilled = isKilled;
        address[][] memory _poolTokensSwapPath = poolTokensSwapPath;

        address crvLp = strategies[_param.strategyId].vault;
        IBank.Position memory pos = bank.getCurrentPositionInfo();
        if (pos.collToken != address(wCurveGauge))
            revert Errors.INCORRECT_COLTOKEN(pos.collToken);
        if (wCurveGauge.getUnderlyingToken(pos.collId) != crvLp)
            revert Errors.INCORRECT_UNDERLYING(crvLp);

        uint256 amountPosRemove = _param.amountPosRemove;

        // 1. Take out collateral - Burn wrapped tokens, receive crv lp tokens and harvest CRV
        bank.takeCollateral(amountPosRemove);
        wCurveGauge.burn(pos.collId, amountPosRemove);

        {
            // 2. Swap rewards tokens to debt token
            uint256 rewards = _doCutRewardsFee(CRV);
            _swapOnUniV2(_swapRouter, CRV, rewards, _swapPath);
        }

        _swapToDebt(
            _param,
            pos,
            crvLp,
            amountPosRemove,
            _isKilled,
            _swapRouter,
            _poolTokensSwapPath
        );

        // 5. Withdraw isolated collateral from Bank
        _doWithdraw(_param.collToken, _param.amountShareWithdraw);

        // 6. Repay
        {
            // Compute repay amount if MAX_INT is supplied (max debt)
            uint256 amountRepay = _param.amountRepay;
            if (amountRepay == type(uint256).max) {
                amountRepay = bank.currentPositionDebt(bank.POSITION_ID());
            }
            _doRepay(_param.borrowToken, amountRepay);
        }

        _validateMaxLTV(_param.strategyId);

        // 7. Refund
        _doRefund(_param.borrowToken);
        _doRefund(_param.collToken);
        _doRefund(CRV);
    }

    function _swapToDebt(
        ClosePosParam memory _param,
        IBank.Position memory pos,
        address crvLp,
        uint amountPosRemove,
        bool isKilled,
        IUniswapV2Router02 swapRouter,
        address[][] memory poolTokensSwapPath
    ) internal {
        (address pool, address[] memory tokens, ) = crvOracle.getPoolInfo(
            crvLp
        );
        // 3. Calculate actual amount to remove
        if (amountPosRemove == type(uint256).max) {
            amountPosRemove = IERC20Upgradeable(crvLp).balanceOf(address(this));
        }

        // 4. Remove liquidity
        int128 tokenIndex;
        uint len = tokens.length;
        for (uint256 i = 0; i < len; i++) {
            if (tokens[i] == pos.debtToken) {
                tokenIndex = int128(uint128(i));
                break;
            }
        }

        uint8 tokenDecimals = IERC20MetadataUpgradeable(pos.debtToken)
            .decimals();

        uint256 sellSlippage = _param.sellSlippage;
        uint256 minOut = (amountPosRemove * sellSlippage) /
            Constants.DENOMINATOR;

        // We assume that there is no token with decimals above than 18
        if (tokenDecimals < 18) {
            minOut = minOut / (uint256(10) ** (18 - tokenDecimals));
        }

        if (isKilled) {
            if (len == 2) {
                uint[2] memory minOuts;
                ICurvePool(pool).remove_liquidity(amountPosRemove, minOuts);
            } else if (len == 3) {
                uint[3] memory minOuts;
                ICurvePool(pool).remove_liquidity(amountPosRemove, minOuts);
            } else if (len == 4) {
                uint[4] memory minOuts;
                ICurvePool(pool).remove_liquidity(amountPosRemove, minOuts);
            } else {
                revert("Invalid pool length");
            }
            for (uint i = 0; i < len; i++) {
                if (i != uint(uint128(tokenIndex))) {
                    address token = tokens[i];
                    uint tokenAmount = IERC20Upgradeable(token).balanceOf(
                        address(this)
                    );
                    _swapOnUniV2(
                        swapRouter,
                        token,
                        tokenAmount,
                        poolTokensSwapPath[i]
                    );
                }
            }
        } else {
            ICurvePool(pool).remove_liquidity_one_coin(
                amountPosRemove,
                int128(tokenIndex),
                minOut
            );
        }
    }

    function _swapOnUniV2(
        IUniswapV2Router02 swapRouter,
        address token,
        uint amount,
        address[] memory path
    ) internal {
        _ensureApprove(token, address(swapRouter), amount);
        swapRouter.swapExactTokensForTokens(
            amount,
            0,
            path,
            address(this),
            block.timestamp
        );
    }
}
