import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fetch from "node-fetch";
import https from "https";
import fs from "fs";

dotenv.config();
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key.");
  process.exit(1);
}

const ADMIN_PASSWORD = "1234"; // ALTERE AQUI

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const VOICE = "alloy";
const PORT = process.env.PORT || 5050;

function getSystemMessage() {
  try {
    return fs.readFileSync("script.txt", "utf8");
  } catch {
    return "Script não encontrado.";
  }
}

async function fetchAgendaData() {
  const url = "https://srv658237.hstgr.cloud/clinica.php";
  const httpsAgent = new https.Agent({ rejectUnauthorized: false });

  try {
    const response = await fetch(url, { agent: httpsAgent });
    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    return await response.text();
  } catch (error) {
    console.error("Agenda fetch error:", error);
    return "";
  }
}

fastify.get("/", async (req, reply) => {
  reply.send({ status: "running" });
});


// ================= ADMIN PANEL =================

fastify.get("/admin", async (req, reply) => {
  const script = getSystemMessage();

  reply.type("text/html").send(`
    <h2>Painel da Atendente</h2>
    <form method="POST" action="/save-script">
      <textarea name="script" rows="20" cols="70">${script}</textarea><br><br>
      Senha: <input type="password" name="password"/><br><br>
      <button type="submit">Salvar</button>
    </form>
  `);
});

fastify.post("/save-script", async (req, reply) => {
  const { script, password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return reply.status(403).send("Acesso negado");
  }

  fs.writeFileSync("script.txt", script);
  reply.send("Script atualizado com sucesso!");
});

// ================= TWILIO CALL =================

fastify.all("/incoming-call", async (request, reply) => {
  const agendaData = await fetchAgendaData();
  const SYSTEM_MESSAGE =
    getSystemMessage() + "\n<Agenda>\n" + agendaData + "\n</Agenda>";

  global.SYSTEM_MESSAGE = SYSTEM_MESSAGE;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
  <Response>
      <Connect>
          <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
  </Response>`;

  reply.type("text/xml").send(twimlResponse);
});


// ================= MEDIA STREAM =================

fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let lastAssistantItem = null;
    let markQueue = [];
    let responseStartTimestampTwilio = null;

    const openAiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    const initializeSession = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 750,
          },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: global.SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      };

      openAiWs.send(JSON.stringify(sessionUpdate));

      openAiWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Cumprimente o usuário e pergunte como pode ajudar." }],
        },
      }));

      openAiWs.send(JSON.stringify({ type: "response.create" }));
    };

    openAiWs.on("open", () => setTimeout(initializeSession, 100));

    openAiWs.on("message", (data) => {
      const response = JSON.parse(data);

      if (response.type === "response.audio.delta" && response.delta) {
        const audioDelta = {
          event: "media",
          streamSid,
          media: { payload: response.delta },
        };
        connection.send(JSON.stringify(audioDelta));
      }
    });

    connection.on("message", (message) => {
      const data = JSON.parse(message);

      switch (data.event) {
        case "media":
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            }));
          }
          break;

        case "start":
          streamSid = data.start.streamSid;
          break;
      }
    });

    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server running on port ${PORT}`);
});
