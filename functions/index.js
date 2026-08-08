const {
  onCall,
  onRequest,
  HttpsError,
} = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const { defineSecret, defineString } = require("firebase-functions/params");
const axios = require("axios");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Set these with:
//   firebase functions:secrets:set ONLINEGH_CLIENT_SECRET
//   firebase functions:config is deprecated for v2 - use `firebase functions:params`
//   or a .env file in the functions directory, e.g.:
//     ONLINEGH_CLIENT_ID=xxxx
//     ONLINEGH_POS_TERMINAL_ID=xxxx
//     ONLINEGH_CALLBACK_BASE_URL=https://<region>-<project>.cloudfunctions.net/onlineghCallback
const ONLINEGH_CLIENT_ID = defineString("ONLINEGH_CLIENT_ID");
const ONLINEGH_CLIENT_SECRET = defineSecret("ONLINEGH_CLIENT_SECRET");
const ONLINEGH_POS_TERMINAL_ID = defineString("ONLINEGH_POS_TERMINAL_ID");
const ONLINEGH_CALLBACK_BASE_URL = defineString("ONLINEGH_CALLBACK_BASE_URL");
// API key for the BoomData / MySpaceServer bundle fulfilment API, used by
// deliverData() to actually dispatch the data bundle once payment clears.
const BOOMDATA_MYSPACESERVER_API_KEY = defineSecret(
  "BOOMDATA_MYSPACESERVER_API_KEY",
);

const getOnlineghConfig = () => ({
  clientId: ONLINEGH_CLIENT_ID.value(),
  clientSecret: ONLINEGH_CLIENT_SECRET.value(),
  posTerminalId: ONLINEGH_POS_TERMINAL_ID.value(),
  callbackBaseUrl: ONLINEGH_CALLBACK_BASE_URL.value(),
});

// ---------------------------------------------------------------------------
// Phone number + network helpers
// ---------------------------------------------------------------------------

// Normalizes any Ghanaian number format (0XXXXXXXXX, 233XXXXXXXXX, XXXXXXXXX)
// into the 233XXXXXXXXX format the gateway expects.
const toTheTellerNumber = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 10) {
    return `233${digits.slice(1)}`;
  }
  if (digits.startsWith("233") && digits.length === 12) {
    return digits;
  }
  if (digits.length === 9) {
    return `233${digits}`;
  }
  return digits;
};

// Ghana MoMo number prefixes, keyed by the r-switch code TheTeller expects.
// This lets the backend infer the network instead of asking the customer.
const NETWORK_PREFIXES = {
  MTN: ["24", "25", "53", "54", "55", "59"],
  VDF: ["20", "50"], // Telecel (formerly Vodafone)
  ATL: ["26", "27", "56", "57"], // AirtelTigo
};

const getTheTellerChannel = (msisdn) => {
  const normalized = toTheTellerNumber(msisdn);
  const prefix = normalized.slice(3, 5); // 2 digits right after "233"
  for (const [network, prefixes] of Object.entries(NETWORK_PREFIXES)) {
    if (prefixes.includes(prefix)) return network;
  }
  return null;
};

// ---------------------------------------------------------------------------
// TheTeller (onlinegh / momopos) gateway client
// ---------------------------------------------------------------------------

const onlineghTokenCache = { token: null, expiresAt: 0 };

const getTheTellerToken = async () => {
  const cfg = getOnlineghConfig();
  const currentTime = Date.now();

  if (
    onlineghTokenCache.token &&
    currentTime < onlineghTokenCache.expiresAt - 5 * 60 * 1000
  ) {
    return onlineghTokenCache.token;
  }

  try {
    const url = `https://api.momopos.theteller.net/gen-token?client_id=${cfg.clientId}&client_secret=${cfg.clientSecret}`;
    const response = await axios.get(url);

    if (response.data && response.data.access_token) {
      onlineghTokenCache.token = response.data.access_token;
      const expiresInMs =
        parseInt(response.data.expires_in || "43200", 10) * 1000;
      onlineghTokenCache.expiresAt = Date.now() + expiresInMs;
      return onlineghTokenCache.token;
    }
    throw new Error("Failed to retrieve access token from response payload");
  } catch (error) {
    logger.error(
      "[TheTeller:onlinegh] Token Generation Error:",
      error.response?.data || error.message,
    );
    throw new Error("Failed to authenticate with TheTeller gateway (onlinegh)");
  }
};

async function startOnlineghPayment({
  msisdn,
  amount,
  itemDesc,
  externalRef,
  callbackUrl,
}) {
  const cfg = getOnlineghConfig();
  const accessToken = await getTheTellerToken();
  const rSwitch = getTheTellerChannel(msisdn);
  const payerNumber = toTheTellerNumber(msisdn);
  const formattedAmount = parseFloat(amount).toFixed(2);

  const payload = {
    amount: formattedAmount,
    processing_code: "000200",
    r_switch: rSwitch,
    pos_terminal_id: cfg.posTerminalId,
    transaction_id: externalRef,
    subscriber_number: payerNumber,
    desc: itemDesc || `Payment for ${externalRef}`,
    currency: "GHS",
    reference: externalRef,
    callback: callbackUrl,
  };

  logger.info(
    `[TheTeller:onlinegh] Start Payment - Ref: ${externalRef} | Switch: ${rSwitch} | Subscriber: ${payerNumber} | Amount: ${formattedAmount}`,
  );

  const res = await axios.post(
    "https://api.momopos.theteller.net/process/tpay-v2",
    payload,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    },
  );

  return { data: res.data, rSwitch, payerNumber };
}

// ---------------------------------------------------------------------------
// Data delivery (BoomData / MySpaceServer fulfilment API)
// ---------------------------------------------------------------------------
// Called once a payment is confirmed via the callback. Dispatches the
// actual bundle purchase to the reseller API and reports back the result.

// MySpaceServer's package catalogue is keyed by network + GB size, not by
// our rSwitch codes, and AirtelTigo has two product lines depending on
// bundle size - so network/package resolution is done independently here
// using the same prefix logic as the fulfilment side.
const getDeliveryNetwork = (phoneZeroFormat, sizeGb) => {
  const prefix = phoneZeroFormat.substring(0, 3);
  const airtelTigoPrefixes = ["026", "056", "027", "057"];
  const telecelPrefixes = ["020", "050"];

  if (airtelTigoPrefixes.includes(prefix)) {
    return sizeGb > 10 ? "AIRTELTIGO_BIGTIME" : "AIRTELTIGO_ISHARE";
  }
  if (telecelPrefixes.includes(prefix)) return "TELECEL";
  return "MTN";
};

const DELIVERY_PACKAGE_ID_MAP = {
  default: {
    "1GB": 20,
    "2GB": 21,
    "3GB": 22,
    "4GB": 23,
    "5GB": 24,
    "6GB": 25,
    "7GB": 26,
    "8GB": 27,
    "10GB": 28,
    "15GB": 29,
    "20GB": 30,
    "25GB": 31,
    "30GB": 32,
    "40GB": 33,
    "50GB": 34,
  },
  telecel: {
    "5GB": 38,
    "10GB": 39,
    "15GB": 40,
    "20GB": 41,
    "25GB": 42,
    "30GB": 43,
    "40GB": 44,
    "50GB": 45,
  },
};

async function deliverData(transactionDoc) {
  const { transactionId, recipientNumber, gb, desc } = transactionDoc;

  // recipientNumber is stored in 233XXXXXXXXX format; the fulfilment API
  // expects the local 0XXXXXXXXX format.
  const rawPhone = recipientNumber || "";
  const customerPhone = rawPhone.startsWith("233")
    ? rawPhone.replace(/^233/, "0")
    : rawPhone;

  // Prefer the explicit `gb` field saved on the transaction; fall back to
  // parsing it out of the description if it's ever missing.
  const gbSource = gb || desc || "";
  const gbMatch = String(gbSource).match(/(\d+)\s*GB/i);
  const extractedSize = gbMatch ? parseInt(gbMatch[1], 10) : 0;
  const gbString = gbMatch ? `${gbMatch[1]}GB` : "";

  if (!gbString) {
    throw new Error(
      `Could not determine bundle size for transaction ${transactionId} (gb="${gb}", desc="${desc}")`,
    );
  }

  const finalNetwork = getDeliveryNetwork(customerPhone, extractedSize);
  const mapGroup =
    finalNetwork === "TELECEL"
      ? DELIVERY_PACKAGE_ID_MAP.telecel
      : DELIVERY_PACKAGE_ID_MAP.default;
  const packageId = mapGroup[gbString];

  if (!packageId) {
    throw new Error(
      `Package configuration variant not found for: ${gbString} on network context ${finalNetwork}`,
    );
  }

  logger.info(
    `[deliverData] Dispatching order - Ref: ${transactionId} | Network: ${finalNetwork} | Package: ${gbString} (${packageId}) | Phone: ${customerPhone}`,
  );

  const apiResponse = await axios.post(
    "https://myspaceserver.com/api/external/orders",
    {
      package_id: packageId,
      customer_phone: customerPhone,
    },
    {
      headers: {
        "X-API-Key": BOOMDATA_MYSPACESERVER_API_KEY.value(),
        "Content-Type": "application/json",
      },
      timeout: 60000,
    },
  );

  logger.info(`[deliverData] Order accepted for ${transactionId}`, {
    status: apiResponse.status,
    orderId: apiResponse.data?.order_id || apiResponse.data?.id || null,
  });

  return {
    packageId,
    network: finalNetwork,
    orderResponse: apiResponse.data,
  };
}

// ---------------------------------------------------------------------------
// initiatePayment - called from the frontend to start a MoMo payment
// ---------------------------------------------------------------------------

exports.initiatePayment = onCall(
  { timeoutSeconds: 60, secrets: [ONLINEGH_CLIENT_SECRET] },
  async ({ data, auth }) => {
    const {
      transaction_id: transactionId,
      desc,
      amount,
      subscriber_number: subscriberNumber,
      recipient_number: recipientNumber,
      provider,
      gb,
      email,
    } = data;

    const userId = auth?.uid || null;

    if (!transactionId || !/^\d{10,14}$/.test(transactionId)) {
      throw new HttpsError(
        "invalid-argument",
        "A valid transaction ID is required",
      );
    }
    if (!desc || typeof desc !== "string") {
      throw new HttpsError("invalid-argument", "Description required");
    }
    if (!amount || isNaN(amount) || parseFloat(amount) <= 0) {
      throw new HttpsError("invalid-argument", "Valid amount required");
    }
    if (
      !subscriberNumber ||
      !/^\d{9,13}$/.test(String(subscriberNumber).replace(/\D/g, ""))
    ) {
      throw new HttpsError(
        "invalid-argument",
        "A valid MoMo number is required",
      );
    }
    if (
      !recipientNumber ||
      !/^\d{9,13}$/.test(String(recipientNumber).replace(/\D/g, ""))
    ) {
      throw new HttpsError(
        "invalid-argument",
        "A valid recipient phone number is required",
      );
    }

    // Infer the network from the MoMo number instead of trusting the client
    const rSwitch = getTheTellerChannel(subscriberNumber);
    if (!rSwitch) {
      throw new HttpsError(
        "invalid-argument",
        "We couldn't detect a supported network (MTN, Telecel, or AirtelTigo) from that MoMo number. Please double-check the number.",
      );
    }

    // Prevent duplicate processing
    const existingDoc = await db
      .collection("transactions")
      .doc(transactionId)
      .get();
    if (existingDoc.exists) {
      const existing = existingDoc.data();
      logger.warn(`Transaction ${transactionId} already exists`);
      return {
        status: existing.status,
        transaction_id: transactionId,
        network: existing.rSwitch,
      };
    }

    const cfg = getOnlineghConfig();
    if (!cfg.callbackBaseUrl) {
      throw new HttpsError(
        "failed-precondition",
        "Server is missing ONLINEGH_CALLBACK_BASE_URL configuration",
      );
    }

    // A random token embedded in the callback URL so we can confirm the
    // callback we receive actually corresponds to a payment we started.
    const callbackToken = crypto.randomBytes(16).toString("hex");
    const callbackUrl = `${cfg.callbackBaseUrl}?transaction_id=${transactionId}&token=${callbackToken}`;

    // Record the pending transaction before contacting the gateway so the
    // frontend can start listening for updates immediately.
    await db
      .collection("transactions")
      .doc(transactionId)
      .set({
        transactionId,
        status: "pending",
        desc,
        amount: parseFloat(amount),
        subscriberNumber: toTheTellerNumber(subscriberNumber),
        recipientNumber: toTheTellerNumber(recipientNumber),
        rSwitch,
        provider: provider || null,
        gb: gb || null,
        email: email || null,
        userId,
        callbackToken,
        exported: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    try {
      const { data: gatewayResponse } = await startOnlineghPayment({
        msisdn: subscriberNumber,
        amount,
        itemDesc: desc,
        externalRef: transactionId,
        callbackUrl,
      });

      logger.info("[TheTeller:lords] Payment prompt response:", {
        transactionId,
        code: gatewayResponse.code,
        reason: gatewayResponse.reason,
      });

      await db
        .collection("transactions")
        .doc(transactionId)
        .update({
          status: "sent",
          gatewayCode: gatewayResponse.code || null,
          gatewayReason: gatewayResponse.reason || null,
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      return {
        status: "sent",
        transaction_id: transactionId,
        network: rSwitch,
        message: "Payment request sent. Please approve it on your MoMo wallet.",
      };
    } catch (error) {
      logger.error("[TheTeller:lords] Payment initiation error:", {
        message: error.response?.data || error.message,
        transactionId,
      });
      await db
        .collection("transactions")
        .doc(transactionId)
        .update({
          status: "failed",
          gatewayReason: error.response?.data?.reason || error.message,
          failedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      throw new HttpsError(
        "internal",
        "Failed to send the payment request. Please try again.",
      );
    }
  },
);

// ---------------------------------------------------------------------------
// lordsCallback - webhook TheTeller calls once the customer approves or
// declines the payment on their MoMo wallet. This confirms the transaction
// and triggers data delivery.
// ---------------------------------------------------------------------------

exports.lordsCallback = onRequest(
  { timeoutSeconds: 60, secrets: [BOOMDATA_MYSPACESERVER_API_KEY] },
  async (req, res) => {
    const transactionId = req.query.transaction_id || req.body?.transaction_id;
    const token = req.query.token;

    if (!transactionId) {
      logger.warn("[lordsCallback] Missing transaction_id on callback");
      res.status(400).send("Missing transaction_id");
      return;
    }

    const docRef = db.collection("transactions").doc(String(transactionId));
    const doc = await docRef.get();

    if (!doc.exists) {
      logger.warn(`[lordsCallback] Unknown transaction: ${transactionId}`);
      res.status(404).send("Unknown transaction");
      return;
    }

    const txn = doc.data();

    if (!token || token !== txn.callbackToken) {
      logger.warn(
        `[lordsCallback] Invalid callback token for ${transactionId}`,
      );
      res.status(403).send("Invalid callback token");
      return;
    }

    const payload = req.body || {};
    const {
      code,
      status: payloadStatus,
      reason,
      "r-switch": rSwitch,
      subscriber_number: subscriberNumber,
    } = payload;

    const isApproved = code === "000" && payloadStatus === "success";
    const finalStatus = isApproved ? "approved" : "declined";

    logger.info(`[lordsCallback] ${transactionId} -> ${finalStatus}`, {
      code,
      reason,
    });

    await docRef.update({
      status: finalStatus,
      gatewayCode: code || null,
      gatewayReason: reason || null,
      rSwitch: rSwitch || txn.rSwitch,
      subscriberNumber: subscriberNumber || txn.subscriberNumber,
      callbackReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
      rawCallback: payload,
    });

    if (isApproved) {
      try {
        const delivery = await deliverData({
          ...txn,
          transactionId,
          rSwitch: rSwitch || txn.rSwitch,
        });
        await docRef.update({
          exported: true,
          deliveryNetwork: delivery.network,
          deliveryPackageId: delivery.packageId,
          deliveredAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (error) {
        logger.error(
          `[lordsCallback] deliverData failed for ${transactionId}:`,
          {
            message: error.response?.data || error.message,
          },
        );
        await docRef.update({
          exported: false,
          deliveryError: error.response?.data?.message || error.message,
          deliveryFailedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }

    // Respond quickly so the gateway doesn't retry the callback.
    res.status(200).send("OK");
  },
);
