// SPDX-License-Identifier: MIT

pragma solidity ^0.8.9;

import './UsingBaseOracle.sol';
import '../utils/HomoraMath.sol';
import '../interfaces/IBaseOracle.sol';
import '../interfaces/IUniswapV2Pair.sol';

contract UniswapV2Oracle is UsingBaseOracle, IBaseOracle {
    using SafeMath for uint256;
    using HomoraMath for uint256;

    constructor(IBaseOracle _base) public UsingBaseOracle(_base) {}

    /// @dev Return the value of the given input as ETH per unit, multiplied by 2**112.
    /// @param pair The Uniswap pair to check the value.
    function getETHPx(address pair) external view override returns (uint256) {
        address token0 = IUniswapV2Pair(pair).token0();
        address token1 = IUniswapV2Pair(pair).token1();
        uint256 totalSupply = IUniswapV2Pair(pair).totalSupply();
        (uint256 r0, uint256 r1, ) = IUniswapV2Pair(pair).getReserves();
        uint256 sqrtK = HomoraMath.sqrt(r0.mul(r1)).fdiv(totalSupply); // in 2**112
        uint256 px0 = base.getETHPx(token0); // in 2**112
        uint256 px1 = base.getETHPx(token1); // in 2**112
        // fair token0 amt: sqrtK * sqrt(px1/px0)
        // fair token1 amt: sqrtK * sqrt(px0/px1)
        // fair lp price = 2 * sqrt(px0 * px1)
        // split into 2 sqrts multiplication to prevent uint overflow (note the 2**112)
        return
            sqrtK
                .mul(2)
                .mul(HomoraMath.sqrt(px0))
                .div(2**56)
                .mul(HomoraMath.sqrt(px1))
                .div(2**56);
    }
}
