import React, { useState, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Modal from "react-modal";
import {
  FaWhatsapp,
  FaWifi,
  FaSearch,
  FaCheckCircle,
  FaSpinner,
  FaTimesCircle,
  FaMobileAlt,
} from "react-icons/fa";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  doc,
  onSnapshot,
} from "firebase/firestore";
import { db, functions } from "./Firebase";
import { httpsCallable } from "firebase/functions";
import "./App.css";
import mtnLogo from "./download.png";
import airtelLogo from "./airtel.png";
import telecelLogo from "./telecel.png";

Modal.setAppElement("#root");

const STATIC_CUSTOMER_EMAIL = "customeremail@gmail.com";

// Network keys match the `boom-bundles/{network}` documents in Firestore.
const NETWORKS = [
  { value: "mtn", label: "MTN", logo: mtnLogo },
  { value: "tigo", label: "AirtelTigo", logo: airtelLogo },
  { value: "telecel", label: "Telecel", logo: telecelLogo },
];

// The r-switch code the backend infers from the MoMo number, mapped back
// to a friendly label for the "approve on your wallet" screen.
const NETWORK_LABELS = {
  MTN: "MTN",
  VDF: "Telecel",
  ATL: "AirtelTigo",
};

const PERIODS = [
  { subcoll: "daily", label: "Daily" },
  { subcoll: "weekly", label: "Weekly" },
  { subcoll: "monthly", label: "Monthly" },
];

// Fetches every active bundle across daily/weekly/monthly for a network
// from boom-bundles/{network}/{daily|weekly|monthly}, and flattens them
// into a single price-sorted list, each tagged with its period.
const loadNetworkBundles = async (network) => {
  if (!["mtn", "tigo", "telecel"].includes(network)) {
    console.error(`Unsupported network requested: ${network}`);
    throw new Error(`Unsupported network: ${network}`);
  }

  const networkRef = doc(db, "bundles", network);
  const all = [];

  for (const { subcoll, label } of PERIODS) {
    const q = query(
      collection(networkRef, subcoll),
      where("active", "==", true),
      orderBy("price", "asc"),
    );
    const snap = await getDocs(q);

    console.log(
      `[Bundles] ${network}/${subcoll} \u2192 found ${snap.size} active plans`,
    );

    snap.docs.forEach((d) => {
      all.push({ id: d.id, period: label, ...d.data() });
    });
  }

  all.sort((a, b) => a.price - b.price);

  console.log(`[Bundles] ${network} total active plans: ${all.length}`);

  return all;
};

// A bundle doc is assumed to look like { size: "1GB", price: 5, validity?: "24 hours" }.
// Adjust this if your field names differ.
const bundleLabel = (bundle) => {
  const size = bundle.size || bundle.volume || bundle.name || bundle.id;
  const price = Number(bundle.price).toFixed(2);
  return `${size} \u2013 GHS ${price}`;
};

// Normalizes a local number (0XXXXXXXXX) or already-formatted 233XXXXXXXXX
// number into the 233XXXXXXXXX format the backend expects.
const formatPhoneNumber = (phone) => {
  let formatted = phone;
  if (phone.startsWith("0") && phone.length === 10) {
    formatted = `233${phone.slice(1)}`;
  } else if (phone.startsWith("233") && phone.length === 12) {
    formatted = phone;
  } else {
    formatted = `233${phone}`;
  }
  return formatted;
};

const generateTransactionId = () => {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0].toString().padStart(12, "0").slice(0, 12);
};

const initiatePayment = httpsCallable(functions, "initiatePayment");

function App() {
  const [selectedNetwork, setSelectedNetwork] = useState("mtn");
  const [bundles, setBundles] = useState([]);
  const [bundlesLoading, setBundlesLoading] = useState(true);
  const [bundlesError, setBundlesError] = useState("");
  const [selectedBundleId, setSelectedBundleId] = useState("");

  const [recipientPhoneNumber, setRecipientPhoneNumber] = useState("");
  const [momoNumber, setMomoNumber] = useState("");
  const [modalIsOpen, setModalIsOpen] = useState(false);
  const [purchaseDetails, setPurchaseDetails] = useState(null);
  const [isPaymentLoading, setIsPaymentLoading] = useState(false);
  const [checkDataModalOpen, setCheckDataModalOpen] = useState(false);
  const [dataPhoneNumber, setDataPhoneNumber] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [paymentStatus, setPaymentStatus] = useState(null);
  const [detectedNetwork, setDetectedNetwork] = useState(null);
  const unsubscribeRef = useRef(null);

  // Load every active bundle for the selected network as soon as the page
  // loads or the network changes - no daily/weekly/monthly picker needed.
  useEffect(() => {
    let cancelled = false;
    setBundlesLoading(true);
    setBundlesError("");
    setSelectedBundleId("");

    loadNetworkBundles(selectedNetwork)
      .then((result) => {
        if (cancelled) return;
        setBundles(result);
        if (result.length > 0) setSelectedBundleId(result[0].id);
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("Failed to load bundles:", error);
        setBundlesError(
          "Couldn't load bundles for this network. Please try again.",
        );
        setBundles([]);
      })
      .finally(() => {
        if (!cancelled) setBundlesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedNetwork]);

  const getSelectedBundle = useMemo(() => {
    return bundles.find((b) => b.id === selectedBundleId);
  }, [bundles, selectedBundleId]);

  const stopListening = () => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  };

  const closeModal = () => {
    setModalIsOpen(false);
    setPurchaseDetails(null);
    setPaymentStatus(null);
    setDetectedNetwork(null);
    stopListening();
    setRecipientPhoneNumber("");
    setMomoNumber("");
  };

  useEffect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => setErrorMessage(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [errorMessage]);

  useEffect(() => () => stopListening(), []);

  // Live-listens for the transaction doc going from pending/sent to
  // approved/declined, updated by the onlineghCallback Cloud Function.
  const listenForPaymentResult = (transactionId) => {
    stopListening();
    const unsub = onSnapshot(doc(db, "transactions", transactionId), (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.rSwitch) setDetectedNetwork(data.rSwitch);
      if (data.status === "approved" || data.status === "declined") {
        setPaymentStatus(data.status);
        if (data.status === "declined") {
          setErrorMessage(
            `Payment declined: ${data.gatewayReason || "Unknown reason"}`,
          );
        }
        stopListening();
      }
    });
    unsubscribeRef.current = unsub;
  };

  const handlePurchase = async (e) => {
    e.preventDefault();

    if (
      !getSelectedBundle ||
      !/^\d{10}$/.test(recipientPhoneNumber) ||
      !/^\d{10}$/.test(momoNumber)
    ) {
      setErrorMessage(
        "Please select a bundle and enter valid 10-digit phone and MoMo numbers.",
      );
      return;
    }

    setIsPaymentLoading(true);
    const transactionId = generateTransactionId();
    const bundleSizeLabel =
      getSelectedBundle.size ||
      getSelectedBundle.volume ||
      getSelectedBundle.id;

    const newPurchaseDetails = {
      network: selectedNetwork.toUpperCase(),
      bundle: bundleSizeLabel,
      period: getSelectedBundle.period,
      price: getSelectedBundle.price,
      number: recipientPhoneNumber,
      momoNumber,
      transid: transactionId,
    };

    setPurchaseDetails(newPurchaseDetails);
    setPaymentStatus(null);
    setDetectedNetwork(null);
    setModalIsOpen(true);

    try {
      const result = await initiatePayment({
        transaction_id: transactionId,
        desc: `${bundleSizeLabel} ${selectedNetwork.toUpperCase()} ${getSelectedBundle.period} Data Bundle`,
        amount: getSelectedBundle.price,
        subscriber_number: formatPhoneNumber(momoNumber),
        recipient_number: formatPhoneNumber(recipientPhoneNumber),
        provider: selectedNetwork.toUpperCase(),
        gb: bundleSizeLabel,
        bundle_id: getSelectedBundle.id,
        period: getSelectedBundle.period,
        email: STATIC_CUSTOMER_EMAIL,
      });

      if (result.data.network) setDetectedNetwork(result.data.network);
      setPaymentStatus("sent");
      listenForPaymentResult(transactionId);
    } catch (error) {
      console.error("Payment initiation error:", error);
      setErrorMessage(error.message || "Payment failed. Please try again.");
      setPurchaseDetails(null);
      setModalIsOpen(false);
    } finally {
      setIsPaymentLoading(false);
    }
  };

  const closeCheckDataModal = () => {
    setCheckDataModalOpen(false);
    setDataPhoneNumber("");
    setErrorMessage("");
  };

  const handleCheckData = async (e) => {
    e.preventDefault();

    if (!/^\d{10}$/.test(dataPhoneNumber)) {
      closeCheckDataModal();
      setErrorMessage("Please enter a valid 10-digit phone or MoMo number.");
      return;
    }

    const formattedPhone = formatPhoneNumber(dataPhoneNumber);

    try {
      let q = query(
        collection(db, "transactions"),
        where("recipientNumber", "==", formattedPhone),
      );
      let snapshot = await getDocs(q);

      if (snapshot.empty) {
        q = query(
          collection(db, "transactions"),
          where("subscriberNumber", "==", formattedPhone),
        );
        snapshot = await getDocs(q);
      }

      if (snapshot.empty) {
        closeCheckDataModal();
        setErrorMessage(`No data bundle found for ${dataPhoneNumber}`);
        return;
      }

      const data = snapshot.docs[0].data();

      let message = "";
      if (data.status === "approved") {
        message = data.exported
          ? "Your data has been delivered."
          : "Payment confirmed - your data is being processed and will be delivered shortly.";
      } else if (data.status === "declined") {
        message = `Payment declined: ${data.gatewayReason || "Unknown reason"}`;
      } else if (data.status === "sent") {
        message = "Payment is awaiting your approval on your MoMo wallet.";
      } else {
        message = `Status: ${data.status}`;
      }

      closeCheckDataModal();
      setErrorMessage(message);
    } catch (error) {
      closeCheckDataModal();
      setErrorMessage(`Error checking status: ${error.message}`);
    }
  };

  const network = detectedNetwork
    ? { label: NETWORK_LABELS[detectedNetwork] }
    : null;

  return (
    <div className="app">
      <AnimatePresence>
        {errorMessage && (
          <motion.div
            className="global-error"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            transition={{ duration: 0.3 }}
          >
            {errorMessage}
          </motion.div>
        )}
      </AnimatePresence>

      <header className="header">
        <motion.div
          className="title-with-icon"
          initial={{ opacity: 0, y: -50 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <FaWifi className="wifi-icon" />
          <h1>Lord's Data</h1>
        </motion.div>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="subtitle"
        >
          Easy & affordable data bundles, delivered fast
        </motion.p>
      </header>

      <motion.section
        className="action-buttons-section"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        
      </motion.section>

      <motion.section className="provider-logos-section">
        <h3>Supported Networks</h3>
        <div className="provider-logos-container">
          {NETWORKS.map((n) => (
            <motion.img
              key={n.value}
              src={n.logo}
              className="provider-logo-img"
              alt={n.label}
              whileHover={{ scale: 1.08 }}
            />
          ))}
        </div>
      </motion.section>

      <motion.section className="purchase-form-container">
        <h2>Purchase Data Bundle</h2>
        <p className="disclaimer-message">
          Data credited within 5 mins - 4 hours
        </p>
        <form onSubmit={handlePurchase} className="purchase-form">
          <div className="form-group">
            <label>Data Network:</label>
            <select
              value={selectedNetwork}
              onChange={(e) => setSelectedNetwork(e.target.value)}
              required
            >
              {NETWORKS.map((n) => (
                <option key={n.value} value={n.value}>
                  {n.label}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>Bundle:</label>
            {bundlesLoading ? (
              <p className="form-hint">
                <FaSpinner className="spin" /> Loading bundles...
              </p>
            ) : bundlesError ? (
              <span className="form-error">{bundlesError}</span>
            ) : bundles.length === 0 ? (
              <p className="form-hint">
                No active bundles for this network right now.
              </p>
            ) : (
              <select
                value={selectedBundleId}
                onChange={(e) => setSelectedBundleId(e.target.value)}
                required
              >
                {bundles.map((b) => (
                  <option key={b.id} value={b.id}>
                    {bundleLabel(b)}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="form-group">
            <label>Recipient Phone Number:</label>
            <input
              type="tel"
              value={recipientPhoneNumber}
              onChange={(e) => setRecipientPhoneNumber(e.target.value)}
              pattern="[0-9]{10}"
              placeholder="0541234567"
              required
              aria-describedby="recipient-phone-error"
            />
            {recipientPhoneNumber && !/^\d{10}$/.test(recipientPhoneNumber) && (
              <span className="form-error" id="recipient-phone-error">
                Please enter a valid 10-digit phone number.
              </span>
            )}
          </div>

          <div className="form-group">
            <label>MoMo Number:</label>
            <input
              type="tel"
              value={momoNumber}
              onChange={(e) => setMomoNumber(e.target.value)}
              pattern="[0-9]{10}"
              placeholder="0541234567"
              required
              aria-describedby="momo-error"
            />
            <span className="form-hint">
              We'll automatically detect your network from this number.
            </span>
            {momoNumber && !/^\d{10}$/.test(momoNumber) && (
              <span className="form-error" id="momo-error">
                Please enter a valid 10-digit MoMo number.
              </span>
            )}
          </div>

          <motion.button
            type="submit"
            disabled={isPaymentLoading || !getSelectedBundle}
            className="submit-button"
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
            aria-label={`Purchase ${getSelectedBundle?.size || ""} bundle for GHS ${getSelectedBundle?.price}`}
          >
            {isPaymentLoading ? (
              <>
                <FaSpinner className="spin" /> Sending request...
              </>
            ) : getSelectedBundle ? (
              `Pay GHS ${getSelectedBundle.price}`
            ) : (
              "Select a bundle"
            )}
          </motion.button>
        </form>
      </motion.section>

      <motion.section className="contact-support">
        <h3>Need Help?</h3>
        <p>
          Contact <a href="tel:0240964167">0240964167</a>
        </p>
      </motion.section>

      <motion.section className="whatsapp-group-section">
        <h3>Join Our Community</h3>
        <p>
          Stay updated with the latest offers and support by joining our
          WhatsApp group!
        </p>
        <motion.a
          href="https://chat.whatsapp.com/E7iqqHV9RgpBcyXeEnRMQP"
          className="whatsapp-group-button"
          whileHover={{ scale: 1.05 }}
          target="_blank"
          rel="noopener noreferrer"
        >
          <FaWhatsapp size={22} /> Join WhatsApp Group
        </motion.a>
      </motion.section>

      <motion.a
        href="https://wa.me/233240964167"
        className="whatsapp-float"
        whileHover={{ scale: 1.1 }}
      >
        <FaWhatsapp size={28} />
      </motion.a>

      <Modal
        isOpen={modalIsOpen}
        onRequestClose={closeModal}
        className="modal"
        overlayClassName="overlay"
        aria-labelledby="pin-modal-title"
      >
        <motion.div
          className="pin-modal"
          initial={{ opacity: 0, y: 50 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          {paymentStatus === "approved" ? (
            <>
              <FaCheckCircle size={48} className="success-icon" />
              <h2 id="pin-modal-title">Payment Successful!</h2>
              <p>{purchaseDetails?.bundle} bundle purchased!</p>
              <p>Your data will be processed shortly.</p>
              <motion.button
                onClick={closeModal}
                className="close-modal-button"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
              >
                Close
              </motion.button>
            </>
          ) : paymentStatus === "declined" ? (
            <>
              <FaTimesCircle size={48} className="error-icon" />
              <h2 id="pin-modal-title">Payment Declined</h2>
              <p>Please try again or contact support.</p>
              <motion.button
                onClick={closeModal}
                className="close-modal-button"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
              >
                Close
              </motion.button>
            </>
          ) : (
            <>
              <FaMobileAlt size={40} className="pending-icon" />
              <h2 id="pin-modal-title">Approve on Your MoMo Wallet</h2>
              <p className="pin-lead">
                A payment request has been sent to{" "}
                <strong>{purchaseDetails?.momoNumber}</strong>
                {network ? ` (${network.label})` : ""}.
              </p>
              <div className="pin-instructions">
                <ol>
                  <li>Check your phone for the prompt or SMS</li>
                  <li>Enter your Mobile Money PIN</li>
                  <li>Approve the payment to complete your purchase</li>
                </ol>
              </div>
              <p className="pin-summary">
                <strong>
                  {purchaseDetails?.bundle} {purchaseDetails?.network} (
                  {purchaseDetails?.period}) - GHS {purchaseDetails?.price}
                </strong>
              </p>
              <p className="timer">
                <FaSpinner className="spin" /> Waiting for your approval...
              </p>
              <motion.button
                onClick={closeModal}
                className="close-modal-button secondary"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                aria-label="Cancel payment"
              >
                Cancel
              </motion.button>
            </>
          )}
        </motion.div>
      </Modal>

      <Modal
        isOpen={checkDataModalOpen}
        onRequestClose={closeCheckDataModal}
        className="modal"
        overlayClassName="overlay"
        aria-labelledby="check-data-modal-title"
      >
        <div className="modal-content">
          <h2 id="check-data-modal-title">
            <FaSearch /> Check Data Status
          </h2>
          <form onSubmit={handleCheckData}>
            <div className="form-group">
              <label>Phone or MoMo Number:</label>
              <input
                type="tel"
                value={dataPhoneNumber}
                onChange={(e) => setDataPhoneNumber(e.target.value)}
                pattern="[0-9]{10}"
                placeholder="0541234567"
                required
                aria-describedby="check-phone-error"
              />
              {dataPhoneNumber && !/^\d{10}$/.test(dataPhoneNumber) && (
                <span className="form-error" id="check-phone-error">
                  Please enter a valid 10-digit phone number.
                </span>
              )}
            </div>
            <motion.button
              type="submit"
              className="submit-button"
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
            >
              Check
            </motion.button>
          </form>
          <motion.button
            onClick={closeCheckDataModal}
            className="close-modal-button secondary"
            whileHover={{ scale: 1.03 }}
            whileTap={{ scale: 0.97 }}
          >
            Cancel
          </motion.button>
        </div>
      </Modal>
    </div>
  );
}

export default App;
