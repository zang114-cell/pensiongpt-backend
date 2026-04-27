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
app.use(cors()); // 모든 출처 허용

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

// ── 토큰 발급 테스트 ──
app.get('/debug/token', async (req, res) => {
  try {
    const token = await getAccessToken();
    res.json({
      success: true,
      tokenPreview: token ? token.slice(0, 20) + '...' : 'none',
      tokenLength: token ? token.length : 0
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
      response: err.response?.data
    });
  }
});
app.get('/debug/env', (req, res) => {
  const id = CODEF_CLIENT_ID;
  const secret = CODEF_CLIENT_SECRET;
  res.json({
    CLIENT_ID_SET: !!id,
    CLIENT_ID_LENGTH: id ? id.length : 0,
    CLIENT_ID_PREVIEW: id ? id.slice(0,8) + '...' : 'undefined',
    CLIENT_SECRET_SET: !!secret,
    CLIENT_SECRET_LENGTH: secret ? secret.length : 0,
    CLIENT_SECRET_PREVIEW: secret ? secret.slice(0,8) + '...' : 'undefined',
    NODE_ENV: process.env.NODE_ENV
  });
});

// ── 연금 조회 응답 로깅 (디버그용) ──
app.post('/api/pension/my-pension-debug', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { userName, identity, loginType } = req.body;
    const response = await axios.post(
      `${CODEF_BASE_URL}/v1/kr/public/fs/pension/my-pension`,
      { organization: '0001', loginType, userName, identity },
      { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    // 전체 응답 그대로 반환 (디버그용)
    res.json({ 
      fullResponse: response.data,
      dataKeys: response.data.data ? Object.keys(response.data.data) : [],
      resultCode: response.data.result?.code,
      resultMsg: response.data.result?.message
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
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
// 국민연금 내연금 알아보기 (국민연금+개인연금+퇴직연금 한번에)
// ══════════════════════════════════════════════
app.post('/api/pension/my-pension', async (req, res) => {
  try {
    const token = await getAccessToken();
    const { userName, identity, loginType, loginTypeLevel, telecom, phoneNo, twoWayInfo, is2Way, simpleAuth } = req.body;

    const body = {
      organization: '0001',
      loginType: loginType || '5',
      userName,
      identity,
    };

    // 간편인증 파라미터
    if (loginType === '5') {
      body.loginTypeLevel = loginTypeLevel || '1'; // 1:카카오톡
      body.userName = userName;
      body.phoneNo = phoneNo || '';
    }

    // 2차 인증 처리
    if (is2Way) {
      body.is2Way = true;
      body.simpleAuth = simpleAuth || '1';
      body.twoWayInfo = twoWayInfo;
    }

    const response = await axios.post(
      `${CODEF_BASE_URL}/v1/kr/public/pp/nps-minwon/my-pension`,
      body,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }
    );

    // CODEF 응답이 URL 인코딩된 문자열인 경우 디코딩
    let data = response.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(decodeURIComponent(data)); } catch(e) {}
    }
    res.json(data);
  } catch (err) {
    console.error('my-pension error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ── 개인연금 별도 엔드포인트 (my-pension에 이미 포함됨) ──
app.post('/api/pension/private', async (req, res) => {
  res.json({ result: { code: 'CF-00000' }, data: {} });
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
