pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract OnChainHistoryNFTFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidArgument();
    error BatchClosedOrDoesNotExist();
    error ReplayDetected();
    error StateMismatch();
    error InvalidProof();

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Batch {
        bool isOpen;
        uint256 totalScore;
        uint256 totalTransactions;
        uint256 totalGovernance;
        uint256 totalGames;
    }
    mapping(uint256 => Batch) public batches;
    uint256 public currentBatchId;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event HistorySubmitted(address indexed provider, uint256 indexed batchId, uint256 score, uint256 transactions, uint256 governance, uint256 games);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 score, uint256 transactions, uint256 governance, uint256 games);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier respectCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; // Default 1 minute cooldown
        currentBatchId = 1; // Start with batch ID 1
        _openBatch(currentBatchId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidArgument();
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (provider == address(0)) revert InvalidArgument();
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            delete isProvider[provider];
            emit ProviderRemoved(provider);
        }
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert Paused(); // Cannot unpause if not paused
        paused = false;
        emit Unpaused(msg.sender);
    }

    function setCooldownSeconds(uint256 newCooldownSeconds) external onlyOwner {
        uint256 oldCooldownSeconds = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownSecondsSet(oldCooldownSeconds, newCooldownSeconds);
    }

    function openNewBatch() external onlyOwner {
        _closeBatch(currentBatchId); // Close current batch if open
        currentBatchId++;
        _openBatch(currentBatchId);
    }

    function _openBatch(uint256 batchId) internal {
        if (batches[batchId].isOpen) revert InvalidArgument(); // Batch already open or invalid ID
        batches[batchId] = Batch({isOpen: true, totalScore: 0, totalTransactions: 0, totalGovernance: 0, totalGames: 0});
        emit BatchOpened(batchId);
    }

    function _closeBatch(uint256 batchId) internal {
        if (!batches[batchId].isOpen) revert BatchClosedOrDoesNotExist();
        batches[batchId].isOpen = false;
        emit BatchClosed(batchId);
    }

    function submitHistory(
        uint256 score,
        uint256 transactions,
        uint256 governance,
        uint256 games
    ) external onlyProvider whenNotPaused respectCooldown {
        lastSubmissionTime[msg.sender] = block.timestamp;

        if (!batches[currentBatchId].isOpen) revert BatchClosedOrDoesNotExist();

        euint32 encryptedScore = FHE.asEuint32(score);
        euint32 encryptedTransactions = FHE.asEuint32(transactions);
        euint32 encryptedGovernance = FHE.asEuint32(governance);
        euint32 encryptedGames = FHE.asEuint32(games);

        // Aggregate to batch totals (encrypted)
        batches[currentBatchId].totalScore = batches[currentBatchId].totalScore.fheAdd(encryptedScore);
        batches[currentBatchId].totalTransactions = batches[currentBatchId].totalTransactions.fheAdd(encryptedTransactions);
        batches[currentBatchId].totalGovernance = batches[currentBatchId].totalGovernance.fheAdd(encryptedGovernance);
        batches[currentBatchId].totalGames = batches[currentBatchId].totalGames.fheAdd(encryptedGames);

        emit HistorySubmitted(msg.sender, currentBatchId, score, transactions, governance, games);
    }

    function requestBatchSummaryDecryption(uint256 batchId) external whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        if (!batches[batchId].isOpen && batches[batchId].totalScore.isInitialized()) {
            // Batch is closed and has data
            euint32[] memory cts = new euint32[](4);
            cts[0] = batches[batchId].totalScore;
            cts[1] = batches[batchId].totalTransactions;
            cts[2] = batches[batchId].totalGovernance;
            cts[3] = batches[batchId].totalGames;

            bytes32 stateHash = _hashCiphertexts(cts);

            uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
            decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
            emit DecryptionRequested(requestId, batchId);
        } else {
            revert BatchClosedOrDoesNotExist(); // Or not closed yet, or no data
        }
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        // Rebuild ciphertexts from storage in the same order as during request
        euint32[] memory cts = new euint32[](4);
        cts[0] = batches[decryptionContexts[requestId].batchId].totalScore;
        cts[1] = batches[decryptionContexts[requestId].batchId].totalTransactions;
        cts[2] = batches[decryptionContexts[requestId].batchId].totalGovernance;
        cts[3] = batches[decryptionContexts[requestId].batchId].totalGames;

        // State verification: ensure ciphertexts haven't changed since request
        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        // Proof verification
        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert InvalidProof();
        }

        // Decode cleartexts
        uint256 score = abi.decode(cleartexts.slice(0, 32), (uint256));
        uint256 transactions = abi.decode(cleartexts.slice(32, 32), (uint256));
        uint256 governance = abi.decode(cleartexts.slice(64, 32), (uint256));
        uint256 games = abi.decode(cleartexts.slice(96, 32), (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, score, transactions, governance, games);
    }

    function _hashCiphertexts(euint32[] memory cts) internal pure returns (bytes32) {
        bytes32[4] memory ctHashes;
        for (uint i = 0; i < cts.length; i++) {
            // FHE.toBytes32 returns the raw bytes of the ciphertext
            ctHashes[i] = keccak256(abi.encodePacked(FHE.toBytes32(cts[i])));
        }
        return keccak256(abi.encode(ctHashes, address(this)));
    }

    function _initIfNeeded(euint32 storage item) internal {
        if (!item.isInitialized()) {
            item = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 storage item) internal view {
        if (!item.isInitialized()) {
            revert InvalidArgument(); // Or a more specific error
        }
    }
}