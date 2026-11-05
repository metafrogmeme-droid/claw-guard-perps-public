// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ClawGuardReceipts} from "../src/ClawGuardReceipts.sol";
import {MiniTest} from "./MiniTest.sol";

contract ClawGuardReceiptsTest is MiniTest {
    ClawGuardReceipts internal c;
    uint256 internal constant KEY = 0xA11CE;
    uint256 internal constant OTHER = 0xB0B;
    address internal signer;

    event Anchored(
        address indexed signer, bytes32 indexed journal, uint64 seq, bytes32 receiptHash, uint8 verdict
    );

    function setUp() public {
        c = new ClawGuardReceipts();
        signer = vm.addr(KEY);
    }

    function _sig(uint256 key, bytes32 h) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _a(uint64 seq, bytes32 h, bytes32 prev, uint8 verdict, uint256 key)
        internal
        pure
        returns (ClawGuardReceipts.Anchor memory)
    {
        return ClawGuardReceipts.Anchor(seq, h, prev, verdict, _sig(key, h));
    }

    function _hash(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("receipt", i));
    }

    function test_anchorsAChain() public {
        bytes32 j = _hash(0);
        vm.expectEmit(true, true, false, true);
        emit Anchored(signer, j, 0, j, 2);
        c.anchor(signer, j, _a(0, j, bytes32(0), 2, KEY));
        c.anchor(signer, j, _a(1, _hash(1), j, 1, KEY));
        c.anchor(signer, j, _a(2, _hash(2), _hash(1), 4, KEY));
        (uint64 next, bytes32 head) = c.headOf(signer, j);
        assertEq(next, 3, "next");
        assertEq(head, _hash(2), "head");
        (uint256 al, uint256 bl, uint256 ok, uint256 other) = c.countsOf(signer);
        assertEq(al, 1, "allowed");
        assertEq(bl, 1, "blocked");
        assertEq(ok, 0, "needs ok");
        assertEq(other, 1, "other");
    }

    function test_batch() public {
        bytes32 j = _hash(0);
        ClawGuardReceipts.Anchor[] memory b = new ClawGuardReceipts.Anchor[](3);
        b[0] = _a(0, j, bytes32(0), 3, KEY);
        b[1] = _a(1, _hash(1), j, 5, KEY);
        b[2] = _a(2, _hash(2), _hash(1), 6, KEY);
        c.anchorBatch(signer, j, b);
        (uint64 next,) = c.headOf(signer, j);
        assertEq(next, 3, "next");
        assertTrue(!c.isStopped(signer), "rearmed");
    }

    function test_emptyBatchReverts() public {
        vm.expectRevert(ClawGuardReceipts.EmptyBatch.selector);
        c.anchorBatch(signer, _hash(0), new ClawGuardReceipts.Anchor[](0));
    }

    function test_killSwitchStopsAndRearmClears() public {
        bytes32 j = _hash(0);
        c.anchor(signer, j, _a(0, j, bytes32(0), 5, KEY));
        assertTrue(c.isStopped(signer), "stopped");
        c.anchor(signer, j, _a(1, _hash(1), j, 6, KEY));
        assertTrue(!c.isStopped(signer), "rearmed");
    }

    function test_rejectsGap() public {
        bytes32 j = _hash(0);
        c.anchor(signer, j, _a(0, j, bytes32(0), 1, KEY));
        vm.expectRevert(abi.encodeWithSelector(ClawGuardReceipts.OutOfOrder.selector, uint64(1), uint64(2)));
        c.anchor(signer, j, _a(2, _hash(2), _hash(1), 1, KEY));
    }

    function test_rejectsReplay() public {
        bytes32 j = _hash(0);
        c.anchor(signer, j, _a(0, j, bytes32(0), 1, KEY));
        vm.expectRevert(abi.encodeWithSelector(ClawGuardReceipts.OutOfOrder.selector, uint64(1), uint64(0)));
        c.anchor(signer, j, _a(0, j, bytes32(0), 1, KEY));
    }

    function test_rejectsFork() public {
        bytes32 j = _hash(0);
        c.anchor(signer, j, _a(0, j, bytes32(0), 1, KEY));
        vm.expectRevert(abi.encodeWithSelector(ClawGuardReceipts.WrongPrev.selector, j, _hash(9)));
        c.anchor(signer, j, _a(1, _hash(1), _hash(9), 1, KEY));
    }

    function test_rejectsWrongJournal() public {
        vm.expectRevert(ClawGuardReceipts.WrongJournal.selector);
        c.anchor(signer, _hash(0), _a(0, _hash(5), bytes32(0), 1, KEY));
    }

    function test_rejectsOtherSigner() public {
        bytes32 j = _hash(0);
        vm.expectRevert(ClawGuardReceipts.BadSignature.selector);
        c.anchor(signer, j, _a(0, j, bytes32(0), 1, OTHER));
    }

    function test_rejectsBadVerdict() public {
        bytes32 j = _hash(0);
        vm.expectRevert(abi.encodeWithSelector(ClawGuardReceipts.BadVerdict.selector, uint8(0)));
        c.anchor(signer, j, _a(0, j, bytes32(0), 0, KEY));
        vm.expectRevert(abi.encodeWithSelector(ClawGuardReceipts.BadVerdict.selector, uint8(7)));
        c.anchor(signer, j, _a(0, j, bytes32(0), 7, KEY));
    }

    function test_rejectsMalformedSignatures() public {
        bytes32 j = _hash(0);
        bytes memory good = _sig(KEY, j);
        // wrong length
        vm.expectRevert(ClawGuardReceipts.BadSignature.selector);
        c.anchor(signer, j, ClawGuardReceipts.Anchor(0, j, bytes32(0), 1, bytes.concat(good, hex"00")));
        // bad v
        bytes memory badV = _sig(KEY, j); // fresh copy: memory bytes alias
        badV[64] = bytes1(uint8(30));
        vm.expectRevert(ClawGuardReceipts.BadSignature.selector);
        c.anchor(signer, j, ClawGuardReceipts.Anchor(0, j, bytes32(0), 1, badV));
        // high s (malleable twin)
        bytes32 r;
        bytes32 s;
        assembly {
            r := mload(add(good, 32))
            s := mload(add(good, 64))
        }
        uint8 v = uint8(good[64]);
        bytes32 highS =
            bytes32(0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141 - uint256(s));
        vm.expectRevert(ClawGuardReceipts.BadSignature.selector);
        c.anchor(
            signer,
            j,
            ClawGuardReceipts.Anchor(
                0, j, bytes32(0), 1, abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27))
            )
        );
        // zero signature recovers address(0)
        vm.expectRevert(ClawGuardReceipts.BadSignature.selector);
        c.anchor(address(0), j, ClawGuardReceipts.Anchor(0, j, bytes32(0), 1, new bytes(65)));
        // v given as 0/1 is accepted
        bytes memory low = _sig(KEY, j);
        low[64] = bytes1(v - 27);
        c.anchor(signer, j, ClawGuardReceipts.Anchor(0, j, bytes32(0), 1, low));
    }

    function test_journalsAreIndependent() public {
        bytes32 j1 = _hash(0);
        bytes32 j2 = _hash(100);
        c.anchor(signer, j1, _a(0, j1, bytes32(0), 1, KEY));
        c.anchor(signer, j2, _a(0, j2, bytes32(0), 1, KEY));
        (uint64 n1,) = c.headOf(signer, j1);
        (uint64 n2,) = c.headOf(signer, j2);
        assertEq(n1, 1, "j1");
        assertEq(n2, 1, "j2");
    }

    /// Any contiguous chain anchors, and the head ends at the last receipt.
    function testFuzz_chain(uint8 len, uint256 salt) public {
        uint256 n = uint256(len) % 24 + 1;
        bytes32 j = keccak256(abi.encode(salt, 0));
        bytes32 prev = bytes32(0);
        for (uint256 i = 0; i < n; ++i) {
            bytes32 h = i == 0 ? j : keccak256(abi.encode(salt, i));
            c.anchor(signer, j, _a(uint64(i), h, prev, uint8(i % 6) + 1, KEY));
            prev = h;
        }
        (uint64 next, bytes32 head) = c.headOf(signer, j);
        assertEq(next, n, "next");
        assertEq(head, prev, "head");
    }

    /// A receipt with the wrong sequence number never anchors.
    function testFuzz_wrongSeqReverts(uint64 seq) public {
        vm.assume(seq != 0);
        bytes32 j = _hash(0);
        vm.expectRevert(abi.encodeWithSelector(ClawGuardReceipts.OutOfOrder.selector, uint64(0), seq));
        c.anchor(signer, j, _a(seq, j, bytes32(0), 1, KEY));
    }

    /// A receipt signed by any other key never anchors for this signer.
    function testFuzz_foreignKeyReverts(uint256 key) public {
        key = key % (0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141 - 1) + 1;
        vm.assume(key != KEY);
        bytes32 j = _hash(0);
        vm.expectRevert(ClawGuardReceipts.BadSignature.selector);
        c.anchor(signer, j, _a(0, j, bytes32(0), 1, key));
    }
}
