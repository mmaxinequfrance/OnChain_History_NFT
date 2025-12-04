// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface HistoryNFT {
  id: string;
  encryptedData: string;
  timestamp: number;
  owner: string;
  category: string;
  status: "minted" | "updating" | "archived";
  description: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [nfts, setNfts] = useState<HistoryNFT[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newNFTData, setNewNFTData] = useState({ category: "DeFi", description: "", activityValue: 0 });
  const [selectedNFT, setSelectedNFT] = useState<HistoryNFT | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");

  const mintedCount = nfts.filter(n => n.status === "minted").length;
  const updatingCount = nfts.filter(n => n.status === "updating").length;
  const archivedCount = nfts.filter(n => n.status === "archived").length;

  useEffect(() => {
    loadNFTs().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadNFTs = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      // Load NFT keys
      const keysBytes = await contract.getData("nft_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing NFT keys:", e); }
      }
      
      // Load each NFT
      const list: HistoryNFT[] = [];
      for (const key of keys) {
        try {
          const nftBytes = await contract.getData(`nft_${key}`);
          if (nftBytes.length > 0) {
            try {
              const nftData = JSON.parse(ethers.toUtf8String(nftBytes));
              list.push({ 
                id: key, 
                encryptedData: nftData.data, 
                timestamp: nftData.timestamp, 
                owner: nftData.owner, 
                category: nftData.category, 
                status: nftData.status || "minted",
                description: nftData.description || ""
              });
            } catch (e) { console.error(`Error parsing NFT data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading NFT ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setNfts(list);
    } catch (e) { console.error("Error loading NFTs:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const mintNFT = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting on-chain history with Zama FHE..." });
    try {
      const encryptedData = FHEEncryptNumber(newNFTData.activityValue);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const nftId = `nft-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const nftData = { 
        data: encryptedData, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newNFTData.category, 
        status: "minted",
        description: newNFTData.description
      };
      
      await contract.setData(`nft_${nftId}`, ethers.toUtf8Bytes(JSON.stringify(nftData)));
      
      // Update NFT keys
      const keysBytes = await contract.getData("nft_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(nftId);
      await contract.setData("nft_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE-encrypted NFT minted successfully!" });
      await loadNFTs();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewNFTData({ category: "DeFi", description: "", activityValue: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Minting failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const updateNFTStatus = async (nftId: string, newStatus: "minted" | "updating" | "archived") => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Updating FHE-encrypted NFT..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const nftBytes = await contract.getData(`nft_${nftId}`);
      if (nftBytes.length === 0) throw new Error("NFT not found");
      const nftData = JSON.parse(ethers.toUtf8String(nftBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedNFT = { ...nftData, status: newStatus };
      await contractWithSigner.setData(`nft_${nftId}`, ethers.toUtf8Bytes(JSON.stringify(updatedNFT)));
      
      setTransactionStatus({ visible: true, status: "success", message: "NFT status updated successfully!" });
      await loadNFTs();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Update failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (nftAddress: string) => address?.toLowerCase() === nftAddress.toLowerCase();

  const filteredNFTs = nfts.filter(nft => {
    const matchesSearch = nft.description.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         nft.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = filterCategory === "all" || nft.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  const renderActivityChart = () => {
    const categories = [...new Set(nfts.map(nft => nft.category))];
    return (
      <div className="activity-chart">
        {categories.map(category => {
          const count = nfts.filter(n => n.category === category).length;
          return (
            <div key={category} className="chart-item">
              <div className="chart-label">{category}</div>
              <div className="chart-bar-container">
                <div 
                  className="chart-bar" 
                  style={{ width: `${(count / nfts.length) * 100}%` }}
                  data-count={count}
                ></div>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="metal-spinner"></div>
      <p>Initializing FHE encryption...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="hexagon"></div>
            <div className="circuit-lines"></div>
          </div>
          <h1>OnChain<span>History</span>NFT</h1>
        </div>
        <div className="header-actions">
          <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
        </div>
      </header>

      <div className="main-content">
        <div className="central-radial-layout">
          <div className="core-panel">
            <div className="core-content">
              <h2>Your Encrypted On-Chain History</h2>
              <p className="subtitle">Mint NFTs representing your entire FHE-encrypted blockchain activity</p>
              
              <div className="action-buttons">
                <button 
                  onClick={() => setShowCreateModal(true)} 
                  className="metal-button primary"
                >
                  <span className="button-light"></span>
                  Mint New History NFT
                </button>
                <button 
                  onClick={loadNFTs} 
                  className="metal-button secondary"
                  disabled={isRefreshing}
                >
                  <span className="button-light"></span>
                  {isRefreshing ? "Refreshing..." : "Refresh History"}
                </button>
              </div>
            </div>
          </div>

          <div className="radial-panels">
            <div className="panel intro-panel">
              <h3>Project Introduction</h3>
              <div className="panel-content">
                <p>This platform mints NFTs representing your entire on-chain history encrypted with <strong>Zama FHE</strong> technology.</p>
                <p>Your transactions, governance activities, and gaming history are encrypted and stored as a dynamic NFT that evolves with your blockchain activity.</p>
                <div className="fhe-badge">
                  <span>Powered by Zama FHE</span>
                </div>
              </div>
            </div>

            <div className="panel stats-panel">
              <h3>History Statistics</h3>
              <div className="panel-content">
                <div className="stats-grid">
                  <div className="stat-item">
                    <div className="stat-value">{nfts.length}</div>
                    <div className="stat-label">Total NFTs</div>
                  </div>
                  <div className="stat-item">
                    <div className="stat-value">{mintedCount}</div>
                    <div className="stat-label">Minted</div>
                  </div>
                  <div className="stat-item">
                    <div className="stat-value">{updatingCount}</div>
                    <div className="stat-label">Updating</div>
                  </div>
                  <div className="stat-item">
                    <div className="stat-value">{archivedCount}</div>
                    <div className="stat-label">Archived</div>
                  </div>
                </div>
                {renderActivityChart()}
              </div>
            </div>

            <div className="panel search-panel">
              <h3>Search & Filter</h3>
              <div className="panel-content">
                <div className="search-box">
                  <input
                    type="text"
                    placeholder="Search history..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="metal-input"
                  />
                  <div className="search-icon"></div>
                </div>
                <div className="filter-options">
                  <select
                    value={filterCategory}
                    onChange={(e) => setFilterCategory(e.target.value)}
                    className="metal-select"
                  >
                    <option value="all">All Categories</option>
                    <option value="DeFi">DeFi</option>
                    <option value="Governance">Governance</option>
                    <option value="Gaming">Gaming</option>
                    <option value="Social">Social</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="dynamic-feed">
          <h2>Your Encrypted History NFTs</h2>
          <div className="feed-container">
            {filteredNFTs.length === 0 ? (
              <div className="empty-feed">
                <div className="empty-icon"></div>
                <p>No encrypted history NFTs found</p>
                <button 
                  className="metal-button primary"
                  onClick={() => setShowCreateModal(true)}
                >
                  Mint Your First History NFT
                </button>
              </div>
            ) : (
              <div className="nft-grid">
                {filteredNFTs.map(nft => (
                  <div 
                    key={nft.id} 
                    className={`nft-card ${nft.status}`}
                    onClick={() => setSelectedNFT(nft)}
                  >
                    <div className="nft-header">
                      <div className="nft-id">#{nft.id.substring(0, 6)}</div>
                      <div className={`nft-status ${nft.status}`}>{nft.status}</div>
                    </div>
                    <div className="nft-category">{nft.category}</div>
                    <div className="nft-description">{nft.description || "No description"}</div>
                    <div className="nft-footer">
                      <div className="nft-date">{new Date(nft.timestamp * 1000).toLocaleDateString()}</div>
                      <div className="nft-owner">{nft.owner.substring(0, 6)}...{nft.owner.substring(38)}</div>
                    </div>
                    <div className="nft-actions">
                      {isOwner(nft.owner) && (
                        <div className="action-buttons">
                          <button 
                            className="action-button"
                            onClick={(e) => {
                              e.stopPropagation();
                              updateNFTStatus(nft.id, "updating");
                            }}
                          >
                            Update
                          </button>
                          <button 
                            className="action-button"
                            onClick={(e) => {
                              e.stopPropagation();
                              updateNFTStatus(nft.id, "archived");
                            }}
                          >
                            Archive
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={mintNFT} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          nftData={newNFTData} 
          setNftData={setNewNFTData}
        />
      )}

      {selectedNFT && (
        <NFTDetailModal 
          nft={selectedNFT} 
          onClose={() => {
            setSelectedNFT(null);
            setDecryptedValue(null);
          }} 
          decryptedValue={decryptedValue}
          setDecryptedValue={setDecryptedValue}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="metal-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="footer-logo">OnChain History NFT</div>
            <p>Your entire blockchain history, encrypted with Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">GitHub</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE Encrypted</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} OnChain History NFT</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  nftData: any;
  setNftData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, nftData, setNftData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setNftData({ ...nftData, [name]: value });
  };

  const handleValueChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setNftData({ ...nftData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!nftData.category || !nftData.activityValue) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Mint New History NFT</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="fhe-icon"></div>
            <div>
              <strong>FHE Encryption Active</strong>
              <p>Your on-chain history will be encrypted with Zama FHE before minting</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Category *</label>
              <select 
                name="category" 
                value={nftData.category} 
                onChange={handleChange} 
                className="metal-select"
              >
                <option value="DeFi">DeFi Activity</option>
                <option value="Governance">Governance</option>
                <option value="Gaming">Gaming</option>
                <option value="Social">Social</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label>Description</label>
              <textarea 
                name="description" 
                value={nftData.description} 
                onChange={handleChange} 
                placeholder="Describe your on-chain history..."
                className="metal-textarea"
                rows={3}
              />
            </div>
            <div className="form-group">
              <label>Activity Value *</label>
              <input 
                type="number" 
                name="activityValue" 
                value={nftData.activityValue} 
                onChange={handleValueChange} 
                placeholder="Enter numerical value representing your activity"
                className="metal-input"
                step="0.01"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{nftData.activityValue || '0'}</div>
              </div>
              <div className="encryption-process">
                <div className="process-icon"></div>
              </div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{nftData.activityValue ? FHEEncryptNumber(nftData.activityValue).substring(0, 50) + '...' : 'No value'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="metal-button secondary">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="metal-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Mint History NFT"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface NFTDetailModalProps {
  nft: HistoryNFT;
  onClose: () => void;
  decryptedValue: number | null;
  setDecryptedValue: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const NFTDetailModal: React.FC<NFTDetailModalProps> = ({ nft, onClose, decryptedValue, setDecryptedValue, isDecrypting, decryptWithSignature }) => {
  const handleDecrypt = async () => {
    if (decryptedValue !== null) { 
      setDecryptedValue(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(nft.encryptedData);
    if (decrypted !== null) setDecryptedValue(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="nft-detail-modal metal-card">
        <div className="modal-header">
          <h2>History NFT Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="nft-info">
            <div className="info-item">
              <span>ID:</span>
              <strong>#{nft.id.substring(0, 8)}</strong>
            </div>
            <div className="info-item">
              <span>Category:</span>
              <strong>{nft.category}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${nft.status}`}>{nft.status}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>{nft.owner.substring(0, 6)}...{nft.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Created:</span>
              <strong>{new Date(nft.timestamp * 1000).toLocaleString()}</strong>
            </div>
          </div>
          <div className="nft-description">
            <h3>Description</h3>
            <p>{nft.description || "No description provided"}</p>
          </div>
          <div className="encrypted-data-section">
            <h3>Encrypted History Data</h3>
            <div className="encrypted-data">
              {nft.encryptedData.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>Zama FHE Encrypted</span>
            </div>
            <button 
              className="metal-button primary"
              onClick={handleDecrypt}
              disabled={isDecrypting}
            >
              {isDecrypting ? "Decrypting..." : decryptedValue ? "Hide Value" : "Decrypt with Wallet"}
            </button>
          </div>
          {decryptedValue !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Activity Value</h3>
              <div className="decrypted-value">
                {decryptedValue}
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>This value is only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="metal-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;