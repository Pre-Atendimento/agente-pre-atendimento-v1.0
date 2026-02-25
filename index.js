import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

dotenv.config();

const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
    console.error("Missing OpenAI API key");
    process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 5050;

/* =========================
   TWILIO WEBHOOK
========================= */

fastify.all("/incoming-call", async (request, reply) => {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;

    reply.type("text/xml").send(twiml);
});

/* =========================
   MEDIA STREAM
========================= */

fastify.register(async (fastify) => {
    fastify.get("/media-stream", { websocket: true }, (connection) => {

        console.log("Client connected");

        let streamSid = null;
        let audioBuffer = Buffer.alloc(0);

        const openAiWs = new WebSocket(
            "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    "OpenAI-Beta": "realtime=v1",
                },
            }
        );

        /* =========================
           OPENAI EVENTS
        ========================= */

        openAiWs.on("open", () => {
            console.log("OpenAI connected");
        });

        openAiWs.on("message", (data) => {
            const msg = JSON.parse(data);

            // sessão pronta
            if (msg.type === "session.created") {
                console.log("Session ready");

                // configura sessão
                openAiWs.send(JSON.stringify({
                    type: "session.update",
                    session: {
                        input_audio_format: "g711_ulaw",
                        output_audio_format: "g711_ulaw",
                        voice: "alloy",
                        modalities: ["audio", "text"],
                        temperature: 0.7,
                    }
                }));

                // 🔥 força fala inicial
                setTimeout(() => {
                    openAiWs.send(JSON.stringify({
                        type: "response.create",
                        response: {
                            modalities: ["audio"],
                            instructions:
                                "Diga exatamente: Olá, sou o assistente da clínica Modelo. Como posso te ajudar?"
                        }
                    }));
                }, 300);
            }

            // áudio vindo do OpenAI
            if (msg.type === "response.audio.delta" && msg.delta && streamSid) {

                const chunk = Buffer.from(msg.delta, "base64");
                audioBuffer = Buffer.concat([audioBuffer, chunk]);

                // Twilio exige frames de 160 bytes
                while (audioBuffer.length >= 160) {
                    const frame = audioBuffer.subarray(0, 160);
                    audioBuffer = audioBuffer.subarray(160);

                    connection.send(JSON.stringify({
                        event: "media",
                        streamSid,
                        media: {
                            payload: frame.toString("base64")
                        }
                    }));
                }
            }
        });

        /* =========================
           TWILIO EVENTS
        ========================= */

        connection.on("message", (message) => {
            const data = JSON.parse(message);

            switch (data.event) {

                case "start":
                    streamSid = data.start.streamSid;
                    console.log("Stream started:", streamSid);
                    break;

                case "media":
                    // envia áudio do caller para OpenAI
                    if (openAiWs.readyState === WebSocket.OPEN) {
                        openAiWs.send(JSON.stringify({
                            type: "input_audio_buffer.append",
                            audio: data.media.payload
                        }));

                        openAiWs.send(JSON.stringify({
                            type: "input_audio_buffer.commit"
                        }));
                    }
                    break;

                case "mark":
                    // controle de fluxo Twilio
                    break;
            }
        });

        connection.on("close", () => {
            console.log("Client disconnected");
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.close();
            }
        });
    });
});

/* =========================
   START SERVER
========================= */

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server running on port ${PORT}`);
});
