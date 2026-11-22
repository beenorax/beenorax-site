/*
 * BENA AI | Gemini Netlify Function
 * Beenorax Analytics & Consulting
 *
 * API key is stored securely in Netlify as GEMINI_API_KEY.
 */

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';

const MAX_BODY_CHARS = 350000;
const MAX_DATASET_CONTEXT_CHARS = 120000;
const MAX_MESSAGE_CHARS = 12000;
const MAX_HISTORY_MESSAGES = 10;
const MAX_OUTPUT_TOKENS = 4096;
const REQUEST_TIMEOUT_MS = 25000;

const RATE_LIMIT_MINUTE = 10;
const RATE_LIMIT_HOUR = 50;

const minuteRequests = new Map();
const hourlyRequests = new Map();

const KB = `
COMPANY:
Beenorax Analytics and Consulting (RC 9728663).

POSITIONING:
Research Intelligence & Business Analytics.

APPROACH:
Discover: Clarify questions, data and decisions.
Design: Frame methods, indicators, analytical workflows and reporting.
Deliver: Analysis, dashboards, reports or training.
Support: Provide guidance, interpretation and quality assurance.

CORE AREAS:
- Research intelligence and scientific research support.
- Statistical analysis and interpretation.
- Data analytics and business intelligence.
- Data visualization and dashboard development.
- Research methodology and analytical workflow design.
- Academic and scientific reporting.
- Training and analytical capacity development.

WORKSPACE:
The Beenorax Analytics Workspace supports statistical analysis,
data management, visualization and business intelligence workflows.

BENA AI:
BENA AI is the research, analytics and business copilot of Beenorax.
It assists users with analytical questions, statistical interpretation,
research support, business analytics and understanding results generated
within the workspace.

RESPONSE PRINCIPLES:
- Give accurate, clear and practical answers.
- Explain statistical results in context.
- Distinguish observed results from assumptions and interpretations.
- Do not invent data, statistical outputs, references or company services.
- Do not claim that an analysis was performed unless the required data
  and results are actually available.
- When information is insufficient, state what is missing.
- Protect confidential information and respect dataset-sharing consent.
`;

const SYSTEM_PROMPT = `
You are BENA AI, the research, analytics and business copilot
of Beenorax Analytics and Consulting.

COMPANY KNOWLEDGE:
${KB}

YOUR RESPONSIBILITIES:

1. STATISTICAL ANALYSIS
Help users understand statistical methods, assumptions, outputs,
effect sizes, confidence intervals, p-values, model diagnostics
and limitations.

2. RESULTS INTERPRETATION
Interpret statistical findings accurately and explain their
practical and scientific implications.

3. RESEARCH SUPPORT
Assist with research questions, study design, methodology,
data interpretation, scientific writing and reporting.

4. DATA ANALYTICS
Support descriptive analysis, inferential statistics,
regression, correlation, hypothesis testing, forecasting,
data visualization and business intelligence.

5. BUSINESS INTELLIGENCE
Help users understand business data, performance indicators,
trends, relationships and analytical findings.

6. WORKSPACE SUPPORT
When dataset context is provided, use the available summary
and analysis results to answer the user's question.
Do not assume access to raw dataset records.

IMPORTANT RULES:

- Never fabricate statistical results or dataset values.
- Never invent citations, journal articles or references.
- Clearly identify limitations in the available information.
- Do not confuse statistical significance with practical importance.
- Do not claim causation from correlation alone.
- Explain uncertainty where relevant.
- Protect user privacy and confidential data.
- Do not claim to have executed software or analyses that you
  have not actually performed.
- Do not invent Beenorax company information.

RESPONSE LENGTH:
Match the depth of the answer to the user's request.
For statistical analysis interpretation, provide a sufficiently
detailed explanation and do not impose an arbitrary word limit.
Use tables where they improve clarity.
Provide step-by-step explanations when appropriate.

STYLE:
Professional, direct, clear and technically accurate.
Avoid unnecessary repetition and generic responses.
`;

const json = (statusCode, data) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  },
  body: JSON.stringify(data)
});

function getClientKey(event) {
  const headers = event.headers || {};

  return (
    headers['x-nf-client-connection-ip'] ||
    headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function checkRateLimit(key) {
  const now = Date.now();
  const minuteWindow = 60 * 1000;
  const hourWindow = 60 * 60 * 1000;

  const minuteHistory = (minuteRequests.get(key) || [])
    .filter(time => now - time < minuteWindow);

  const hourHistory = (hourlyRequests.get(key) || [])
    .filter(time => now - time < hourWindow);

  if (minuteHistory.length >= RATE_LIMIT_MINUTE) {
    return false;
  }

  if (hourHistory.length >= RATE_LIMIT_HOUR) {
    return false;
  }

  minuteHistory.push(now);
  hourHistory.push(now);

  minuteRequests.set(key, minuteHistory);
  hourlyRequests.set(key, hourHistory);

  return true;
}

function cleanMessages(messages) {
  if (!Array.isArray(messages)) return [];

  const cleaned = messages
    .slice(-MAX_HISTORY_MESSAGES)
    .filter(message =>
      message &&
      ['user', 'assistant', 'model'].includes(message.role) &&
      typeof message.content === 'string'
    )
    .map(message => ({
      role: message.role === 'assistant' ? 'model' : message.role,
      content: message.content.slice(0, MAX_MESSAGE_CHARS).trim()
    }))
    .filter(message => message.content.length > 0);

  const merged = [];

  for (const message of cleaned) {
    const previous = merged[merged.length - 1];

    if (previous && previous.role === message.role) {
      previous.content += '\n\n' + message.content;
    } else {
      merged.push({ ...message });
    }
  }

  return merged;
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') {
    return json(405, {
      error: 'method_not_allowed'
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error('BENA AI: GEMINI_API_KEY is missing.');

    return json(503, {
      error: 'unavailable'
    });
  }

  const clientKey = getClientKey(event);

  if (!checkRateLimit(clientKey)) {
    return json(429, {
      error: 'rate_limit'
    });
  }

  try {
    const rawBody = event.body || '';

    if (rawBody.length > MAX_BODY_CHARS) {
      return json(413, {
        error: 'request_too_large'
      });
    }

    const payload = JSON.parse(rawBody);

    const messages = cleanMessages(payload.messages);

    if (!messages.length) {
      return json(400, {
        error: 'messages_required'
      });
    }

    if (messages[messages.length - 1].role !== 'user') {
      return json(400, {
        error: 'last_message_must_be_user'
      });
    }

    /*
     * Dataset information is accepted only when the user
     * explicitly grants consent.
     */

    let datasetContext = '';

    if (
      payload.datasetConsent === true &&
      typeof payload.datasetContext === 'string'
    ) {
      datasetContext = payload.datasetContext
        .slice(0, MAX_DATASET_CONTEXT_CHARS)
        .trim();
    }

    let systemInstruction = SYSTEM_PROMPT;

    if (datasetContext) {
      systemInstruction += `

USER-PROVIDED AGGREGATED DATASET CONTEXT:

${datasetContext}

DATASET INSTRUCTIONS:
Use this information when answering questions about the dataset.
Interpret only the values and results actually provided.
Do not assume access to the original raw dataset.
Do not invent missing observations or statistical outputs.
`;
    }

    const contents = messages.map(message => ({
      role: message.role,
      parts: [
        {
          text: message.content
        }
      ]
    }));

    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    let response;

    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          method: 'POST',

          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey
          },

          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: systemInstruction
                }
              ]
            },

            contents,

            generationConfig: {
              temperature: 0.4,
              maxOutputTokens: MAX_OUTPUT_TOKENS
            }
          }),

          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      console.error(
        'BENA AI Gemini error:',
        response.status
      );

      return json(502, {
        error: 'upstream',
        status: response.status
      });
    }

    const result = await response.json();

    const reply = result.candidates?.[0]?.content?.parts
      ?.map(part => part.text || '')
      .join('')
      .trim();

    if (!reply) {
      console.error(
        'BENA AI: Gemini returned no usable response.'
      );

      return json(502, {
        error: 'empty_response'
      });
    }

    return json(200, {
      reply,
      model: MODEL,
      finishReason: result.candidates?.[0]?.finishReason || null
    });

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('BENA AI: Gemini request timed out.');

      return json(504, {
        error: 'timeout'
      });
    }

    console.error(
      'BENA AI function error:',
      error.message
    );

    return json(500, {
      error: 'internal'
    });
  }
};
