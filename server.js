/**
 * 연금GPT 백엔드 서버
 * - CODEF API 토큰 발급 (Client Secret을 서버에서만 보관)
 * - 금융감독원 통합연금포털 연금 조회 프록시
 * - Railway에 배포
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*', // Netlify 주소로 변경
  credentials: true
}));

// ── 환경변수 (Railway에서 설정) ──
const CODEF_CLIENT_ID     = process.env.CODEF_CLIENT_ID;
const CODEF_CLIENT_SECRET = process.env.CODEF_CLIENT_SECRET;
const CODEF_BASE_URL      = 'https://development.codef.io'; // 데모: development / 정식: api.codef.io
const CODEF_OAUTH_URL     = 'https://oauth.codef.io';

// ── 토큰 캐시 (메모리, 1시간 유효) ──
let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const credentials = Buffer.from(`${CODEF_CLIENT_ID}:${CODEF_CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    `${CODEF_OAUTH_URL}/oauth/token`,
    'grant_type=client_credentials&scope=read',
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${credentials}`
      }
    }
  );
  tokenCache = {
    token: res.data.access_token,
    expiresAt: Date.now() + (res.data.expires_in - 60) * 1000
  };
  return tokenCache.token;
}

// ── 루트 ──
app.get('/', (req, res) => {
  res.json({ service: '연금GPT 백엔드', status: 'ok', timestamp: new Date().toISOString() });
});

// ── 헬스체크 ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════
// STEP 1: 금융감독원 통합연금포털 회원가입 확인
// ══════════════════════════════════════════════
app.post('/api/pension/check-member', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { userName, identity, loginType } = req.body;

    const response = await axios.post(
      `${CODEF_BASE_URL}/v1/kr/public/fs/0001/register`,
      { organization: '0001', loginType, userName, identity },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (err) {
    console.error('check-member error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ══════════════════════════════════════════════
// STEP 2: 금융감독원 내 연금정보 조회
// (개인연금 + IRP + 퇴직연금 한번에)
// ══════════════════════════════════════════════
app.post('/api/pension/my-pension', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { userName, identity, loginType, twoWayInfo } = req.body;

    const body = {
      organization: '0001',
      loginType: loginType || '5', // 5: 간편인증, 0: 공동인증서
      userName,
      identity,
    };
    // 2차 인증(간편인증 승인 후 재요청) 처리
    if (twoWayInfo) body.twoWayInfo = twoWayInfo;

    const response = await axios.post(
      `${CODEF_BASE_URL}/v1/kr/public/fs/pension/my-pension`,
      body,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (err) {
    console.error('my-pension error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ══════════════════════════════════════════════
// STEP 3: 국민연금 예상수령액 조회
// ══════════════════════════════════════════════
app.post('/api/pension/nps', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { userName, identity, loginType, twoWayInfo } = req.body;

    const body = {
      organization: '0002', // 국민연금공단
      loginType: loginType || '5',
      userName,
      identity,
    };
    if (twoWayInfo) body.twoWayInfo = twoWayInfo;

    const response = await axios.post(
      `${CODEF_BASE_URL}/v1/kr/public/nps/pension/my-pension`,
      body,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (err) {
    console.error('nps error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ══════════════════════════════════════════════
// STEP 4: 2차 인증 완료 확인 (간편인증용)
// ══════════════════════════════════════════════
app.post('/api/pension/two-way', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { endpoint, twoWayInfo, originalBody } = req.body;

    const response = await axios.post(
      `${CODEF_BASE_URL}${endpoint}`,
      { ...originalBody, twoWayInfo, is2Way: true },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (err) {
    console.error('two-way error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`연금GPT 백엔드 서버 실행 중 — PORT ${PORT}`);
  console.log(`CODEF Client ID: ${CODEF_CLIENT_ID ? '✅ 설정됨' : '❌ 미설정'}`);
});
