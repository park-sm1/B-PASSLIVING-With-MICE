const express = require("express");
const session = require("express-session");
const morgan = require("morgan");
const path = require("path");

const app = express();

/* =========================
   ENV
========================= */
const PORT = process.env.PORT || 3000;

// ⚠️ Render에서는 반드시 BASE_URL 환경변수 설정
// 예: https://b-passliving.onrender.com
const BASE_URL =
  process.env.BASE_URL || `http://localhost:${PORT}`;

const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev_secret";

const KAKAO_REST_API_KEY =
  process.env.KAKAO_REST_API_KEY || "";

const KAKAO_REDIRECT_URI =
  process.env.KAKAO_REDIRECT_URI ||
  `${BASE_URL}/auth/kakao/callback`;

const TOSS_CLIENT_KEY =
  process.env.TOSS_CLIENT_KEY || "";

const TOSS_SECRET_KEY =
  process.env.TOSS_SECRET_KEY || "";

/* =========================
   MIDDLEWARE
========================= */
app.use(morgan("dev"));
app.use(express.json());

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: {
      httpOnly: true,
    },
  })
);

/* =========================
   STATIC FILES
========================= */
app.use(express.static(path.join(__dirname, "public")));

// 루트 접속 시 index.html 보장
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================
   IN-MEMORY ORDER STORE (데모용)
========================= */
const orders = new Map();

/* =========================
   SESSION HELPERS
========================= */
function getSessionUser(req) {
  return req.session.user || null;
}

function setSessionUser(req, user) {
  req.session.user = user;
}

function clearSessionUser(req) {
  delete req.session.user;
  delete req.session.pass;
}

function getPass(req) {
  return req.session.pass || null;
}

function setActivePass7Days(req) {
  const now = new Date();
  const end = new Date(
    now.getTime() + 7 * 24 * 60 * 60 * 1000
  );

  req.session.pass = {
    status: "ACTIVE",
    plan_id: "living_week_7d",
    start_at: now.toISOString(),
    end_at: end.toISOString(),
  };
}

/* =========================
   API: ME
========================= */
app.get("/api/me", (req, res) => {
  const user = getSessionUser(req);
  const pass = getPass(req);

  if (!user) {
    return res.status(401).json({ error: "NOT_LOGGED_IN" });
  }

  const plan = {
    id: "living_week_7d",
    name: "Living Week (7일)",
    amount: 99000,
  };

  res.json({
    user,
    pass,
    plan,
    tossClientKey: TOSS_CLIENT_KEY || null,
  });
});

/* =========================
   API: LOGOUT
========================= */
app.post("/api/logout", (req, res) => {
  clearSessionUser(req);
  res.json({ ok: true });
});

/* =========================
   API: ORDER CREATE
========================= */
app.post("/api/orders/create", (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: "NOT_LOGGED_IN" });
  }

  const amount = 99000;
  const orderId =
    "order_" + Date.now() + "_" + Math.random().toString(16).slice(2);

  const orderName = "B·PASS Living Week (7일)";

  orders.set(orderId, {
    amount,
    orderName,
    createdAt: Date.now(),
    userId: user.id,
  });

  res.json({
    orderId,
    orderName,
    amount,
    successUrl: `${BASE_URL}/payment/success?orderId=${encodeURIComponent(
      orderId
    )}`,
    failUrl: `${BASE_URL}/payment/fail?orderId=${encodeURIComponent(orderId)}`,
  });
});

/* =========================
   PAYMENT SUCCESS / FAIL
========================= */
app.get("/payment/success", async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.redirect("/?paid=0");

  const { paymentKey, orderId, amount } = req.query;

  const order = orders.get(orderId);
  if (!order) return res.redirect("/?paid=0");

  const amt = Number(amount || order.amount);
  if (!Number.isFinite(amt) || amt !== order.amount) {
    return res.redirect("/?paid=0");
  }

  // 토스 결제 승인 (실키 있을 때만)
  if (TOSS_SECRET_KEY && paymentKey) {
    try {
      const auth = Buffer.from(`${TOSS_SECRET_KEY}:`).toString("base64");

      const resp = await fetch(
        "https://api.tosspayments.com/v1/payments/confirm",
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            paymentKey,
            orderId,
            amount: order.amount,
          }),
        }
      );

      if (!resp.ok) {
        return res.redirect("/?paid=0");
      }
    } catch (err) {
      return res.redirect("/?paid=0");
    }
  }

  setActivePass7Days(req);
  return res.redirect("/?paid=1");
});

app.get("/payment/fail", (req, res) => {
  return res.redirect("/?paid=0");
});

/* =========================
   KAKAO AUTH
========================= */
app.get("/auth/kakao/start", (req, res) => {
  // 🔹 키 없으면 데모 로그인
  if (!KAKAO_REST_API_KEY) {
    setSessionUser(req, {
      id: 1001,
      name: "Demo User",
    });
    return res.redirect("/?login=1");
  }

  const params = new URLSearchParams({
    client_id: KAKAO_REST_API_KEY,
    redirect_uri: KAKAO_REDIRECT_URI,
    response_type: "code",
  });

  res.redirect(
    `https://kauth.kakao.com/oauth/authorize?${params.toString()}`
  );
});

app.get("/auth/kakao/callback", async (req, res) => {
  if (!KAKAO_REST_API_KEY) return res.redirect("/?login=1");

  const code = req.query.code;
  if (!code) return res.redirect("/?login=0");

  try {
    const tokenResp = await fetch(
      "https://kauth.kakao.com/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/x-www-form-urlencoded;charset=utf-8",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: KAKAO_REST_API_KEY,
          redirect_uri: KAKAO_REDIRECT_URI,
          code: String(code),
        }).toString(),
      }
    );

    if (!tokenResp.ok) return res.redirect("/?login=0");
    const tokenData = await tokenResp.json();

    const meResp = await fetch(
      "https://kapi.kakao.com/v2/user/me",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      }
    );

    if (!meResp.ok) return res.redirect("/?login=0");
    const me = await meResp.json();

    const kakaoId = me.id;
    const nickname =
      me?.kakao_account?.profile?.nickname ||
      me?.properties?.nickname ||
      "Kakao User";

    setSessionUser(req, {
      id: kakaoId,
      name: nickname,
    });

    return res.redirect("/?login=1");
  } catch (err) {
    return res.redirect("/?login=0");
  }
});

/* =========================
   RUN
========================= */
app.listen(PORT, () => {
  console.log(`Server running: ${BASE_URL}`);
});
