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

/// @title EnsureApprove
/// @notice Helper to ensure approvals are set correctly
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../libraries/UniversalERC20.sol";

abstract contract EnsureApprove {
    /// @dev Reset approval to zero and then approve spender with amount
    /// @param token Address of token to approve
    /// @param spender Address to approve
    /// @param amount Amount to approve
    function _ensureApprove(address token, address spender, uint256 amount) internal {
        UniversalERC20.universalApprove(IERC20(token), spender, amount);
    }
}
