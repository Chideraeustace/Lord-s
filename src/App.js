import React, {
  useState,
  useMemo,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import Modal from "react-modal";
import {
  FaWhatsapp,
  FaWifi,
  FaSearch,
  FaUserShield,
  FaCheckCircle,
  FaSpinner,
  FaTimesCircle,
} from "react-icons/fa";
import { signInWithEmailAndPassword, onAuthStateChanged } from "firebase/auth";
import { collection, query, where, getDocs } from "firebase/firestore";
import { db, auth, functions } from "./Firebase";
import { httpsCallable } from "firebase/functions";
import "./App.css";
import mtn from "./download.png";
import airtel from "./airtel.png";
import telecel from "./telecel.png";

Modal.setAppElement("#root");

const THETELLER_CONFIG = {
  merchantId: "TTM-00009769",
};

const STATIC_CUSTOMER_EMAIL = "customeremail@gmail.com";

const PAYMENT_NETWORKS = [
  { value: "MTN", label: "MTN" },
  { value: "ATL", label: "Airtel" },
  { value: "VDF", label: "Telecel" },
];

const providersData = {
  airtel: [
    { gb: 1, price: 5.0 },
    { gb: 2, price: 9.0 },
    { gb: 3, price: 14.0 },
    { gb: 4, price: 19.0 },
    { gb: 5, price: 25.0 },
    { gb: 6, price: 30.0 },
    { gb: 7, price: 35.0 },
    { gb: 8, price: 44.0 },
    { gb: 10, price: 50.0 },
    { gb: 12, price: 60.0 },
    { gb: 15, price: 58.0 },
    { gb: 20, price: 85.0 },
    { gb: 25, price: 100.0 },
    { gb: 30, price: 130.0 },
    { gb: 40, price: 180.0 },
    { gb: 50, price: 235.0 },
    { gb: 100, price: 450.0 },
  ],
  telecel: [
    { gb: 1, price: 5.0 },
    { gb: 2, price: 9.0 },
    { gb: 3, price: 14.0 },
    { gb: 4, price: 19.0 },
    { gb: 5, price: 25.0 },
    { gb: 6, price: 30.0 },
    { gb: 7, price: 35.0 },
    { gb: 8, price: 44.0 },
    { gb: 10, price: 50.0 },
    { gb: 12, price: 60.0 },
    { gb: 15, price: 58.0 },
    { gb: 20, price: 85.0 },
    { gb: 25, price: 100.0 },
    { gb: 30, price: 130.0 },
    { gb: 40, price: 180.0 },
    { gb: 50, price: 235.0 },
    { gb: 100, price: 450.0 },
  ],
  mtn: [
    { gb: 1, price: 7.0 },
    { gb: 2, price: 11.5 },
    { gb: 3, price: 17.5 },
    { gb: 4, price: 23.0 },
    { gb: 5, price: 28.0 },
    { gb: 6, price: 35.0 },
    { gb: 8, price: 43.0 },
    { gb: 10, price: 52.0 },
    { gb: 15, price: 75.0 },
    { gb: 20, price: 93.0 },
    { gb: 25, price: 115.0 },
    { gb: 30, price: 140.0 },
    { gb: 40, price: 180.0 },
    { gb: 50, price: 220.0 },
  ],
};

function App() {
  const navigate = useNavigate();
  const [selectedProvider, setSelectedProvider] = useState("airtel");
  const [selectedBundleSize, setSelectedBundleSize] = useState("1");
  const [recipientPhoneNumber, setRecipientPhoneNumber] = useState("");
  const [momoNumber, setMomoNumber] = useState("");
  const [paymentNetwork, setPaymentNetwork] = useState("ATL");
  const [modalIsOpen, setModalIsOpen] = useState(false);
  const [purchaseDetails, setPurchaseDetails] = useState(null);
  const [isPaymentLoading, setIsPaymentLoading] = useState(false);
  const [checkDataModalOpen, setCheckDataModalOpen] = useState(false);
  const [agentPortalModalOpen, setAgentPortalModalOpen] = useState(false);
  const [dataPhoneNumber, setDataPhoneNumber] = useState("");
  const [agentEmail, setAgentEmail] = useState("");
  const [agentPassword, setAgentPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [agentFullName, setAgentFullName] = useState("");
  const [agentPhone, setAgentPhone] = useState("");
  const [agentMomoNumber, setAgentMomoNumber] = useState("");
  const [agentPaymentNetwork, setAgentPaymentNetwork] = useState("ATL");
  const [agentSignUpEmail, setAgentSignUpEmail] = useState("");
  const [signUpUsername, setSignUpUsername] = useState("");
  const [signUpPassword, setSignUpPassword] = useState("");
  const [agentSignUpDetails, setAgentSignUpDetails] = useState(null);
  const [currentUser, setCurrentUser] = useState(null);
  const [signupError, setSignupError] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [paymentStatus, setPaymentStatus] = useState(null);
  const [countdown, setCountdown] = useState(null);
  const [isAgentSignup, setIsAgentSignup] = useState(false); // Added back
  const statusCache = useRef(new Map());
  const timeoutRef = useRef(null);
  const initiateThetellerPayment = useCallback(
    httpsCallable(functions, "initiateThetellerPayment"),
    []
  );

  const providerLogos = { mtn, airtel, telecel }; // Added back

  const formatPhoneNumber = useCallback((phone) => {
    let formatted = phone;
    if (phone.startsWith("0") && phone.length === 10) {
      formatted = `233${phone.slice(1)}`;
    } else if (phone.startsWith("233") && phone.length === 12) {
      formatted = phone;
    } else {
      formatted = `233${phone}`;
    }
    return formatted;
  }, []);

  const closeModal = () => {
    setModalIsOpen(false);
    setPurchaseDetails(null);
    setAgentSignUpDetails(null);
    setPaymentStatus(null);
    setErrorMessage("");
    setCountdown(null);
    setIsAgentSignup(false);
    statusCache.current.clear();
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (!currentUser) {
      setRecipientPhoneNumber("");
      setMomoNumber("");
      setPaymentNetwork("ATL");
      setSelectedProvider("airtel");
      setSelectedBundleSize("1");
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, setCurrentUser);
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => setErrorMessage(""), 5000);
      return () => clearTimeout(timer);
    }
  }, [errorMessage]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      setCountdown(null);
      return;
    }
    const timer = setInterval(() => {
      setCountdown((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  const checkPaymentStatus = useCallback(async () => {
    const transactionId =
      purchaseDetails?.transid || agentSignUpDetails?.transid;
    if (!transactionId) {
      setErrorMessage("No transaction ID available.");
      closeModal();
      return;
    }

    if (statusCache.current.has(transactionId)) {
      const cachedStatus = statusCache.current.get(transactionId);
      console.log(`Using cached status for ${transactionId}:`, cachedStatus);
      setPaymentStatus(cachedStatus.final_status);
      return;
    }

    try {
      console.log(`Checking status for transaction ${transactionId}`);
      const result = await initiateThetellerPayment({
        transaction_id: transactionId,
        isCallback: true,
      });

      const { final_status, code, reason } = result.data;
      console.log(`Received status for ${transactionId}:`, {
        final_status,
        code,
        reason,
      });

      statusCache.current.set(transactionId, { final_status, code, reason });
      setPaymentStatus(final_status);

      if (final_status === "approved") {
        if (isAgentSignup && agentSignUpDetails) {
          try {
            await signInWithEmailAndPassword(
              auth,
              agentSignUpDetails.email,
              agentSignUpDetails.password
            );
            setErrorMessage(
              `🎉 Welcome ${agentSignUpDetails.fullName}! Agent account created & logged in!`
            );
            closeModal();
            navigate("/agent-portal");
            return;
          } catch (loginError) {
            setErrorMessage(
              `Payment successful! Please login with your credentials.`
            );
          }
        }
      } else if (final_status === "declined") {
        setErrorMessage(`Payment declined: ${reason || "Unknown reason"}`);
      }
    } catch (error) {
      console.error(`Status check error for ${transactionId}:`, error);
      setErrorMessage(`Failed to check payment status: ${error.message}`);
    }
  }, [
    purchaseDetails,
    agentSignUpDetails,
    currentUser,
    formatPhoneNumber,
    initiateThetellerPayment,
    isAgentSignup,
    navigate,
  ]);

  const generateTransactionId = useCallback(() => {
    const array = new Uint32Array(1);
    crypto.getRandomValues(array);
    return array[0].toString().padStart(12, "0").slice(0, 12);
  }, []);

  const getSelectedBundle = useMemo(() => {
    return providersData[selectedProvider]?.find(
      (bundle) => bundle.gb === Number(selectedBundleSize)
    );
  }, [selectedProvider, selectedBundleSize]);

  const handlePurchase = async (e) => {
    e.preventDefault();

    if (
      !getSelectedBundle ||
      !/^\d{10}$/.test(recipientPhoneNumber) ||
      !/^\d{10}$/.test(momoNumber)
    ) {
      setErrorMessage("Please enter valid 10-digit phone and MoMo numbers.");
      return;
    }

    setIsPaymentLoading(true);
    setIsAgentSignup(false);
    statusCache.current.clear();
    const transactionId = generateTransactionId();
    const amountInPesewas = (getSelectedBundle.price * 100).toFixed(0);

    const newPurchaseDetails = {
      provider: selectedProvider.toUpperCase(),
      gb: getSelectedBundle.gb,
      price: getSelectedBundle.price,
      number: recipientPhoneNumber,
      momoNumber,
      paymentNetwork,
      transid: transactionId,
    };

    setPurchaseDetails(newPurchaseDetails);
    setPaymentStatus(null);
    setCountdown(30);
    setModalIsOpen(true);

    try {
      console.log("Initiating payment:", {
        transactionId,
        recipientPhoneNumber,
      });
      const result = await initiateThetellerPayment({
        merchant_id: THETELLER_CONFIG.merchantId,
        transaction_id: transactionId,
        desc: `${
          getSelectedBundle.gb
        }GB ${selectedProvider.toUpperCase()} Data Bundle`,
        amount: amountInPesewas,
        subscriber_number: formatPhoneNumber(momoNumber),
        recipient_number: recipientPhoneNumber,
        r_switch: paymentNetwork,
        email: STATIC_CUSTOMER_EMAIL,
        isAgentSignup: false,
      });

      setPaymentStatus(result.data.status);
      setErrorMessage(
        `📱 Transaction initiated for MoMo number ${momoNumber}!`
      );

      timeoutRef.current = setTimeout(() => {
        checkPaymentStatus();
      }, 35000);
    } catch (error) {
      console.error("Payment initiation error:", error);
      setErrorMessage( `Payment failed/Declined: Try Again`);
      setPurchaseDetails(null);
      setCountdown(null);
      setModalIsOpen(false);
    } finally {
      setIsPaymentLoading(false);
    }
  };

  const handleAgentSignUpPayment = async (e) => {
    e.preventDefault();

    if (
      !agentFullName ||
      !agentPhone ||
      !agentMomoNumber ||
      !agentSignUpEmail ||
      !signUpUsername ||
      !signUpPassword ||
      !agentPaymentNetwork
    ) {
      setSignupError("Please fill all fields.");
      return;
    }

    if (!/^\d{10}$/.test(agentPhone) || !/^\d{10}$/.test(agentMomoNumber)) {
      setSignupError("Please enter valid 10-digit phone and MoMo numbers.");
      return;
    }

    if (
      !agentSignUpEmail.match(
        /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
      )
    ) {
      setSignupError("Please enter a valid email address.");
      return;
    }

    setIsPaymentLoading(true);
    setSignupError("");
    setIsAgentSignup(true);
    statusCache.current.clear();
    const transactionId = generateTransactionId();

    const agentDetails = {
      fullName: agentFullName,
      phone: agentPhone,
      momoNumber: agentMomoNumber,
      paymentNetwork: agentPaymentNetwork,
      email: agentSignUpEmail,
      username: signUpUsername,
      password: signUpPassword,
      transid: transactionId,
    };

    setAgentSignUpDetails(agentDetails);
    setPaymentStatus(null);
    setCountdown(30);
    setModalIsOpen(true);
    setAgentPortalModalOpen(false);

    try {
      console.log("Initiating agent signup payment:", { transactionId });
      const result = await initiateThetellerPayment({
        merchant_id: THETELLER_CONFIG.merchantId,
        transaction_id: transactionId,
        desc: JSON.stringify(agentDetails),
        amount: (50.0 * 100).toFixed(0),
        subscriber_number: formatPhoneNumber(agentMomoNumber),
        r_switch: agentPaymentNetwork,
        email: STATIC_CUSTOMER_EMAIL,
        isAgentSignup: true,
      });

      setPaymentStatus(result.data.status);
      setErrorMessage(
        `📱 Agent registration payment initiated for MoMo number ${agentMomoNumber}!`
      );

      timeoutRef.current = setTimeout(() => {
        checkPaymentStatus();
      }, 30000);
    } catch (error) {
      console.error("Agent signup payment error:", error);
      setSignupError(
        error.code === "invalid-argument"
          ? error.message
          : `Payment failed: ${error.message}`
      );
      setAgentSignUpDetails(null);
      setCountdown(null);
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

  const closeAgentPortalModal = () => {
    setAgentPortalModalOpen(false);
    setAgentEmail("");
    setAgentPassword("");
    setIsSignUp(false);
    setSignupError("");
    setAgentFullName("");
    setAgentPhone("");
    setAgentMomoNumber("");
    setAgentPaymentNetwork("ATL");
    setAgentSignUpEmail("");
    setSignUpUsername("");
    setSignUpPassword("");
  };

  const handleCheckData = async (e) => {
    e.preventDefault();

    // Validate phone number (10 digits to match UI pattern)
    if (!/^\d{10}$/.test(dataPhoneNumber)) {
      closeCheckDataModal();
      setErrorMessage("Please enter a valid 10-digit phone or MoMo number.");
      return;
    }

    // Format phone number to match Firestore (e.g., "233537113751")
    const formattedPhone = formatPhoneNumber(dataPhoneNumber);

    try {
      // Query data_approve_teller_transaction collection
      let q = query(
        collection(db, "approve_teller_transaction"),
        where("recipient_number", "==", formattedPhone)
      );
      let snapshot = await getDocs(q);
      console.log(`[DEBUG] Recipient number query returned `);

      // If no match, try subscriber_number
      if (snapshot.empty) {
        q = query(
          collection(db, "approve_teller_transaction"),
          where("subscriber_number", "==", formattedPhone)
        );
        snapshot = await getDocs(q);
      }

      if (snapshot.empty) {
        closeCheckDataModal();
        setErrorMessage(`No data bundle found for ${dataPhoneNumber}`);
        return;
      }

      // Check the first matching document
      const doc = snapshot.docs[0];
      const data = doc.data();

      let message = "";
      if (data.status === "approved") {
        if (data.exported === true) {
          message =
            "Data is being processed and will be delivered in 10 minutes.";
        } else {
          message = "Data not processed.";
        }
      } else if (data.status === "declined") {
        message = `❌ Payment declined: ${data.reason || "Unknown reason"}`;
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

  const handleAgentLogin = async (e) => {
    e.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, agentEmail, agentPassword);
      setErrorMessage(`Logged in as agent with email ${agentEmail}!`);
      closeAgentPortalModal();
      navigate("/agent-portal");
    } catch (error) {
      console.error("Agent login error:", error);
      setErrorMessage(`Login failed: ${error.message}`);
    }
  };

  return (
    <div className="app">
      {errorMessage && (
        <motion.div
          className="global-error"
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          {errorMessage}
        </motion.div>
      )}
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
          Easy & Affordable Data Bundle Purchase
          {currentUser && <span> | Welcome, {currentUser.email} (Agent)</span>}
        </motion.p>
      </header>

      <motion.section
        className="action-buttons-section"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <div className="action-buttons-container">
          <motion.button
            className="action-button check-data-btn"
            onClick={() => setCheckDataModalOpen(true)}
            whileHover={{ scale: 1.05 }}
          >
            <FaSearch /> Check Data Status
          </motion.button>
          <motion.button
            className="action-button agent-portal-btn"
            onClick={() => setAgentPortalModalOpen(true)}
            whileHover={{ scale: 1.05 }}
          >
            <FaUserShield /> Agent Portal
          </motion.button>
        </div>
      </motion.section>

      <motion.section className="provider-logos-section">
        <h3>Supported Networks</h3>
        <div className="provider-logos-container">
          {Object.keys(providerLogos).map((provider) => (
            <motion.img
              key={provider}
              src={providerLogos[provider]}
              className="provider-logo-img"
              alt={provider}
              whileHover={{ scale: 1.1 }}
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
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value)}
              required
            >
              {Object.keys(providersData).map((p) => (
                <option key={p} value={p}>
                  {p.toUpperCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label>Bundle:</label>
            <select
              value={selectedBundleSize}
              onChange={(e) => setSelectedBundleSize(e.target.value)}
              required
            >
              {providersData[selectedProvider]?.map((b) => (
                <option key={b.gb} value={b.gb}>
                  {b.gb}GB (GHS {b.price})
                </option>
              ))}
            </select>
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
            {momoNumber && !/^\d{10}$/.test(momoNumber) && (
              <span className="form-error" id="momo-error">
                Please enter a valid 10-digit MoMo number.
              </span>
            )}
          </div>
          <div className="form-group">
            <label>Payment Network:</label>
            <select
              value={paymentNetwork}
              onChange={(e) => setPaymentNetwork(e.target.value)}
              required
            >
              {PAYMENT_NETWORKS.map((network) => (
                <option key={network.value} value={network.value}>
                  {network.label}
                </option>
              ))}
            </select>
          </div>
          <motion.button
            type="submit"
            disabled={isPaymentLoading || !getSelectedBundle}
            className="submit-button"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            aria-label={`Purchase ${getSelectedBundle?.gb}GB bundle for GHS ${getSelectedBundle?.price}`}
          >
            {isPaymentLoading ? (
              <>
                <FaSpinner className="spin" /> Processing...
              </>
            ) : (
              `Pay GHS ${getSelectedBundle?.price}`
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
          <FaWhatsapp size={24} /> Join WhatsApp Group
        </motion.a>
      </motion.section>

      <motion.a
        href="https://wa.me/233240964167"
        className="whatsapp-float"
        whileHover={{ scale: 1.1 }}
      >
        <FaWhatsapp size={30} />
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
              <FaCheckCircle size={50} className="success-icon" />
              <h2 id="pin-modal-title">🎉 Payment Successful!</h2>
              <p>
                {isAgentSignup
                  ? "Agent registration completed!"
                  : `${purchaseDetails?.gb}GB bundle purchased!`}
              </p>
              <p>
                {isAgentSignup
                  ? "Logging you in..."
                  : "Data will be processed shortly."}
              </p>
              <motion.button
                onClick={closeModal}
                className="close-modal-button"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                {isAgentSignup ? "Redirecting..." : "Close"}
              </motion.button>
            </>
          ) : paymentStatus === "declined" ? (
            <>
              <FaTimesCircle size={50} className="error-icon" />
              <h2 id="pin-modal-title">❌ Payment Declined</h2>
              <p>Please try again or contact support.</p>
              <motion.button
                onClick={closeModal}
                className="close-modal-button"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
              >
                Close
              </motion.button>
            </>
          ) : (
            <>
              <h2 id="pin-modal-title">📱 Processing Payment</h2>
              <p>
                <strong>Sent to MoMo Number:</strong>{" "}
                {purchaseDetails?.momoNumber || agentSignUpDetails?.momoNumber}
              </p>
              <div className="pin-instructions">
                <ol>
                  <li>Check SMS on your phone</li>
                  <li>Enter your Mobile Money PIN</li>
                  <li>Approve payment</li>
                </ol>
              </div>
              <p>
                <strong>
                  {isAgentSignup
                    ? "Agent Registration (GHS 50)"
                    : `${purchaseDetails?.gb}GB ${purchaseDetails?.provider}`}
                </strong>
              </p>
              <p className="timer">
                {countdown !== null
                  ? `Checking in ${countdown}s...`
                  : "Checking status..."}
              </p>
              <motion.button
                onClick={checkPaymentStatus}
                className="check-btn"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                aria-label="Check payment status"
                disabled={countdown !== null || paymentStatus}
              >
                <FaSpinner className="spin" /> Check Now
              </motion.button>
              <motion.button
                onClick={closeModal}
                className="close-modal-button secondary"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
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
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              Check
            </motion.button>
          </form>
          <motion.button
            onClick={closeCheckDataModal}
            className="close-modal-button secondary"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
          >
            Cancel
          </motion.button>
        </div>
      </Modal>

      <Modal
        isOpen={agentPortalModalOpen}
        onRequestClose={closeAgentPortalModal}
        className="modal"
        overlayClassName="overlay"
        aria-labelledby="agent-portal-modal-title"
      >
        <div className="modal-content">
          <h2 id="agent-portal-modal-title">
            <FaUserShield /> Agent Portal
          </h2>
          <div className="toggle-buttons">
            <button
              type="button"
              className={`toggle-btn ${!isSignUp ? "active" : ""}`}
              onClick={() => setIsSignUp(false)}
            >
              Login
            </button>
            <button
              type="button"
              className={`toggle-btn ${isSignUp ? "active" : ""}`}
              onClick={() => setIsSignUp(true)}
            >
              Sign Up
            </button>
          </div>

          {isSignUp ? (
            <form onSubmit={handleAgentSignUpPayment} className="simple-form">
              <p>
                <strong>Step 1:</strong> Pay GHS 50 → <strong>Step 2:</strong>{" "}
                Account auto-created!
              </p>
              {signupError && (
                <p className="error-message" style={{ color: "red" }}>
                  {signupError}
                </p>
              )}
              <div className="form-group">
                <label>Full Name:</label>
                <input
                  type="text"
                  value={agentFullName}
                  onChange={(e) => setAgentFullName(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>Contact Phone Number:</label>
                <input
                  type="tel"
                  value={agentPhone}
                  onChange={(e) => setAgentPhone(e.target.value)}
                  pattern="[0-9]{10}"
                  placeholder="0541234567"
                  required
                  aria-describedby="agent-phone-error"
                />
                {agentPhone && !/^\d{10}$/.test(agentPhone) && (
                  <span className="form-error" id="agent-phone-error">
                    Please enter a valid 10-digit phone number.
                  </span>
                )}
              </div>
              <div className="form-group">
                <label>MoMo Number:</label>
                <input
                  type="tel"
                  value={agentMomoNumber}
                  onChange={(e) => setAgentMomoNumber(e.target.value)}
                  pattern="[0-9]{10}"
                  placeholder="0541234567"
                  required
                  aria-describedby="agent-momo-error"
                />
                {agentMomoNumber && !/^\d{10}$/.test(agentMomoNumber) && (
                  <span className="form-error" id="agent-momo-error">
                    Please enter a valid 10-digit MoMo number.
                  </span>
                )}
              </div>
              <div className="form-group">
                <label>Payment Network:</label>
                <select
                  value={agentPaymentNetwork}
                  onChange={(e) => setAgentPaymentNetwork(e.target.value)}
                  required
                >
                  {PAYMENT_NETWORKS.map((network) => (
                    <option key={network.value} value={network.value}>
                      {network.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Email:</label>
                <input
                  type="email"
                  value={agentSignUpEmail}
                  onChange={(e) => setAgentSignUpEmail(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>Username:</label>
                <input
                  type="text"
                  value={signUpUsername}
                  onChange={(e) => setSignUpUsername(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>Password:</label>
                <input
                  type="password"
                  value={signUpPassword}
                  onChange={(e) => setSignUpPassword(e.target.value)}
                  required
                />
              </div>
              <motion.button
                type="submit"
                disabled={isPaymentLoading}
                className="submit-button"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                aria-label="Pay GHS 50 and register as agent"
              >
                {isPaymentLoading ? (
                  <>
                    <FaSpinner className="spin" /> Processing...
                  </>
                ) : (
                  "Pay GHS 50 & Register"
                )}
              </motion.button>
            </form>
          ) : (
            <form onSubmit={handleAgentLogin} className="simple-form">
              <div className="form-group">
                <label>Email:</label>
                <input
                  type="email"
                  value={agentEmail}
                  onChange={(e) => setAgentEmail(e.target.value)}
                  required
                />
              </div>
              <div className="form-group">
                <label>Password:</label>
                <input
                  type="password"
                  value={agentPassword}
                  onChange={(e) => setAgentPassword(e.target.value)}
                  required
                />
              </div>
              <motion.button
                type="submit"
                className="submit-button"
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                aria-label="Login to agent portal"
              >
                Login
              </motion.button>
            </form>
          )}
          <motion.button
            onClick={closeAgentPortalModal}
            className="close-modal-button secondary"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            aria-label="Close agent portal modal"
          >
            Cancel
          </motion.button>
        </div>
      </Modal>
    </div>
  );
}

export default App;
