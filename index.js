import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fetch from "node-fetch";
import https from "https";

dotenv.config();
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error("Missing OpenAI API key.");
    process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

function obterDataFormatada() {
    const hoje = new Date();
    return hoje.toLocaleDateString("pt-BR", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "America/Sao_Paulo",
    });
}

const SYSTEM_MESSAGE_BASE = `Você é uma assistente telefônica da clínica Modelo. Hoje é dia ${obterDataFormatada()}.
Siga as instruções da agenda e auxilie no agendamento.`;

async function fetchAgendaData() {
    const url = "https://srv658237.hstgr.cloud/clinica.php";
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });

    try {
        const res = await fetch(url, { agent: httpsAgent });
        return await res.text();
    } catch (e) {
        console.error("Agenda error:", e);
        return "";
    }
}

const VOICE = "alloy";
const PORT = process.env.PORT || 5050;

fastify.get("/", async (_, reply) => {
    reply.send({ ok: true });
});

fastify.all("/incoming-call", async (request, reply) => {
    const agenda = await fetchAgendaData();
    global.SYSTEM_MESSAGE =
        SYSTEM_MESSAGE_BASE + "\n<Agenda>\n" + agenda + "\n</Agenda>";

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
    </Connect>
</Response>`;

    reply.type("text/xml").send(twiml);
});

fastify.register(async (fastify) => {
    fastify.get("/media-stream", { websocket: true }, (connection) => {
        console.log("Client connected");

        let streamSid = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTwilio = null;

        // 🔥 FLAGS DE SINCRONIZAÇÃO
        let twilioStarted = false;
        let openaiReady = false;
        let sessionInitialized = false;

        const openAiWs = new WebSocket(
            "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    "OpenAI-Beta": "realtime=v1",
                },
            }
        );

        const tryInit = () => {
            if (sessionInitialized) return;
            if (!twilioStarted || !openaiReady) return;

            sessionInitialized = true;
            initializeSession();
        };

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
            sendInitialGreeting();
        };

        const sendInitialGreeting = () => {
            openAiWs.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "user",
                    content: [{
                        type: "input_text",
                        text: 'Comprimente o usuário: "Oi, sou um assistente da clínica Modelo, como posso te ajudar?"'
                    }]
                }
            }));

            openAiWs.send(JSON.stringify({ type: "response.create" }));
        };

        openAiWs.on("open", () => {
            console.log("OpenAI connected");
            openaiReady = true;
            tryInit();
        });

        openAiWs.on("message", (data) => {
            const response = JSON.parse(data);

            if (response.type === "response.audio.delta" && response.delta && streamSid) {

                connection.send(JSON.stringify({
                    event: "media",
                    streamSid,
                    media: { payload: response.delta } // ✅ envia direto
                }));

                if (!responseStartTimestampTwilio)
                    responseStartTimestampTwilio = latestMediaTimestamp;

                if (response.item_id)
                    lastAssistantItem = response.item_id;

                connection.send(JSON.stringify({
                    event: "mark",
                    streamSid,
                    mark: { name: "responsePart" }
                }));

                markQueue.push("responsePart");
            }
        });

        connection.on("message", (message) => {
            const data = JSON.parse(message);

            switch (data.event) {

                case "start":
                    streamSid = data.start.streamSid;
                    twilioStarted = true;
                    latestMediaTimestamp = 0;
                    console.log("Stream started:", streamSid);
                    tryInit();
                    break;

                case "media":
                    latestMediaTimestamp = data.media.timestamp;

                    if (openAiWs.readyState === WebSocket.OPEN) {
                        openAiWs.send(JSON.stringify({
                            type: "input_audio_buffer.append",
                            audio: data.media.payload
                        }));
                    }
                    break;

                case "mark":
                    if (markQueue.length) markQueue.shift();
                    break;
            }
        });

        connection.on("close", () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log("Client disconnected");
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
