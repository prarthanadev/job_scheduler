const { GoogleGenAI } = require('@google/genai');
require('dotenv').config();

const aiKey = process.env.GEMINI_API_KEY;
const ai = aiKey ? new GoogleGenAI({ apiKey: aiKey }) : null;

const generateFailureSummary = async (errorMessage, logLogs) => {
  if (!ai) {
    return 'AI summary unavailable: GEMINI_API_KEY is not configured.';
  }

  try {
    const logsText = logLogs.map(l => `[${l.log_level}] ${l.message}`).join('\n');
    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: `Summarize this job failure in plain English and suggest a fix category.\n\nError: ${errorMessage}\nLogs:\n${logsText}`
    });

    return response.text.trim();
  } catch (error) {
    console.error('Failed to call Gemini API:', error);
    return 'Failed to generate AI analysis summary due to API error.';
  }
};

module.exports = { generateFailureSummary };
