// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ClawGuardReceipts} from "../src/ClawGuardReceipts.sol";
import {MiniTest} from "./MiniTest.sol";

/// Receipts produced and signed by the TypeScript journal (anvil key 0, see test/anchor.test.ts, which checks
/// the same bytes come out of signReceipt). Anchoring them here proves both sides agree on hash and signature.
contract CrossLanguageTest is MiniTest {
    address internal constant SIGNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    function _r(uint256 i) internal pure returns (ClawGuardReceipts.Anchor memory) {
        if (i == 0) {
            return ClawGuardReceipts.Anchor(
                0,
                0x1e6d6fce5cb028370106e98625b322248a97535fb5789ac6ae5bc7010c658432,
                bytes32(0),
                2,
                hex"b293c8804a73db00a83a5fdd04d94b117bd6ad57fdd9ba86f304e4b1e3574dd95878646ff71e65f929649d7904e93248936f92283258571fc7da3659b1f18c9a1c"
            );
        }
        if (i == 1) {
            return ClawGuardReceipts.Anchor(
                1,
                0xf437c0c108d316017ec148156d47077e8d57ac54dd2f231f3c70e81b738af6ba,
                0x1e6d6fce5cb028370106e98625b322248a97535fb5789ac6ae5bc7010c658432,
                1,
                hex"812e186c7502aec47b5c03741c9dd56c6b35280afe6da086fed02ef29478e9cd2e982fc81524947c4a799ca6c6121c25e71c28b24fbef8b1a1d4e5d8495fcbee1b"
            );
        }
        if (i == 2) {
            return ClawGuardReceipts.Anchor(
                2,
                0x48a9fba9c96e5ff82d0dfc08410adc76bd3574583dd5d0e640e0e742725036bc,
                0xf437c0c108d316017ec148156d47077e8d57ac54dd2f231f3c70e81b738af6ba,
                5,
                hex"2d62b0c657c3763923631d0a9d9adf9eacbe7f5892afbad403fb8dc4bedadbe147ec5e90a8e4476fa3698ff26956e1a2f1add33c2fd1ba3128f2abd42ec64aa01b"
            );
        }
        revert("index");
    }

    function test_anchorsTypescriptReceipts() public {
        ClawGuardReceipts c = new ClawGuardReceipts();
        bytes32 journal = _r(0).receiptHash;
        ClawGuardReceipts.Anchor[] memory b = new ClawGuardReceipts.Anchor[](3);
        for (uint256 i = 0; i < 3; ++i) {
            b[i] = _r(i);
        }
        c.anchorBatch(SIGNER, journal, b);
        (uint64 next, bytes32 head) = c.headOf(SIGNER, journal);
        assertEq(next, 3, "next");
        assertEq(head, _r(2).receiptHash, "head");
        assertTrue(c.isStopped(SIGNER), "kill switch receipt stops the signer");
    }
}
