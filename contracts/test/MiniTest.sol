// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// Minimal test base: the cheatcodes and assertions these tests use, so the repo needs no submodule.
interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function expectRevert(bytes calldata revertData) external;
    function expectRevert(bytes4 revertData) external;
    function expectEmit(bool t1, bool t2, bool t3, bool data) external;
    function assume(bool condition) external pure;
}

contract MiniTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error AssertionFailed(string what);

    function assertEq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert AssertionFailed(what);
    }

    function assertEq(bytes32 a, bytes32 b, string memory what) internal pure {
        if (a != b) revert AssertionFailed(what);
    }

    function assertTrue(bool c, string memory what) internal pure {
        if (!c) revert AssertionFailed(what);
    }
}
