// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ClawGuardReceipts
/// @notice On-chain anchor for Claw Guard Perps receipt journals. Each journal is a hash chain of receipts
///         signed (EIP-191 over the raw 32-byte hash) by the operator's receipt key. Anyone may submit a
///         receipt; the contract checks the signature and that it extends the journal's head, so the
///         anchored sequence is exactly the signer's chain with no gaps, forks or reordering.
/// @dev A journal is identified by its first receipt's hash. A kill-switch receipt marks the signer as
///      stopped until a later re-arm receipt, which other contracts or keepers can read with isStopped().
contract ClawGuardReceipts {
    uint8 public constant VERDICT_ALLOWED = 1;
    uint8 public constant VERDICT_BLOCKED = 2;
    uint8 public constant VERDICT_NEEDS_OK = 3;
    uint8 public constant KIND_EXECUTION = 4;
    uint8 public constant KIND_KILL_SWITCH = 5;
    uint8 public constant KIND_REARM = 6;

    bytes32 private constant SECP256K1_HALF_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct Head {
        uint64 nextSeq;
        bytes32 head;
    }

    struct Anchor {
        uint64 seq;
        bytes32 receiptHash;
        bytes32 prevHash;
        uint8 verdict;
        bytes sig;
    }

    /// signer => journal id (hash of receipt 0) => head
    mapping(address => mapping(bytes32 => Head)) private _heads;
    mapping(address => bool) private _stopped;
    mapping(address => uint256[4]) private _counts; // allowed, blocked, needs_ok, other

    event Anchored(
        address indexed signer, bytes32 indexed journal, uint64 seq, bytes32 receiptHash, uint8 verdict
    );
    event Stopped(address indexed signer, bytes32 indexed journal, uint64 seq);
    event Rearmed(address indexed signer, bytes32 indexed journal, uint64 seq);

    error BadVerdict(uint8 verdict);
    error BadSignature();
    error OutOfOrder(uint64 expectedSeq, uint64 gotSeq);
    error WrongPrev(bytes32 expectedPrev, bytes32 gotPrev);
    error WrongJournal();
    error EmptyBatch();

    function anchor(address signer, bytes32 journal, Anchor calldata a) external {
        _anchor(signer, journal, a);
    }

    function anchorBatch(address signer, bytes32 journal, Anchor[] calldata batch) external {
        if (batch.length == 0) revert EmptyBatch();
        for (uint256 i = 0; i < batch.length; ++i) {
            _anchor(signer, journal, batch[i]);
        }
    }

    function headOf(address signer, bytes32 journal) external view returns (uint64 nextSeq, bytes32 head) {
        Head storage h = _heads[signer][journal];
        return (h.nextSeq, h.head);
    }

    function isStopped(address signer) external view returns (bool) {
        return _stopped[signer];
    }

    /// @return allowed blocked needsOk other  verdict counts across all of the signer's journals
    function countsOf(address signer)
        external
        view
        returns (uint256 allowed, uint256 blocked, uint256 needsOk, uint256 other)
    {
        uint256[4] storage c = _counts[signer];
        return (c[0], c[1], c[2], c[3]);
    }

    function _anchor(address signer, bytes32 journal, Anchor calldata a) private {
        if (a.verdict == 0 || a.verdict > KIND_REARM) revert BadVerdict(a.verdict);
        Head storage h = _heads[signer][journal];
        if (a.seq != h.nextSeq) revert OutOfOrder(h.nextSeq, a.seq);
        if (a.prevHash != h.head) revert WrongPrev(h.head, a.prevHash);
        if (a.seq == 0 && a.receiptHash != journal) revert WrongJournal();
        if (_recover(a.receiptHash, a.sig) != signer) revert BadSignature();

        h.nextSeq = a.seq + 1;
        h.head = a.receiptHash;
        _counts[signer][a.verdict <= VERDICT_NEEDS_OK ? a.verdict - 1 : 3] += 1;
        emit Anchored(signer, journal, a.seq, a.receiptHash, a.verdict);
        if (a.verdict == KIND_KILL_SWITCH) {
            _stopped[signer] = true;
            emit Stopped(signer, journal, a.seq);
        } else if (a.verdict == KIND_REARM) {
            _stopped[signer] = false;
            emit Rearmed(signer, journal, a.seq);
        }
    }

    /// EIP-191 personal_sign over the raw 32-byte hash, low-s only, v in {27, 28}.
    function _recover(bytes32 hash, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        if ((v != 27 && v != 28) || uint256(s) > uint256(SECP256K1_HALF_N)) revert BadSignature();
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
        address who = ecrecover(digest, v, r, s);
        if (who == address(0)) revert BadSignature();
        return who;
    }
}
