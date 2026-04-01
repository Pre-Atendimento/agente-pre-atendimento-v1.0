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

const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 5050;

fastify.all("/incoming-call", async (request, reply) => {
    const twiml =
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<Response>' +
        '<Connect>' +
        '<Stream url="wss://' + request.headers.host + '/media-stream" />' +
        '</Connect>' +
        '</Response>';

    reply.type("text/xml").send(twiml);
});

fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", { websocket: true }, (connection) => {
        console.log("Client connected");

        let streamSid = null;
        let audioBuffer = Buffer.alloc(0);
        let sessionReady = false;
        let greetingSent = false;

        const openAiWs = new WebSocket(
            "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01",
            {
                headers: {
                    Authorization: `Bearer ${OPENAI_API_KEY}`,
                    "OpenAI-Beta": "realtime=v1",
                },
            }
        );

        function maybeSendGreeting() {
            if (!sessionReady) return;
            if (!streamSid) return;
            if (greetingSent) return;
            if (openAiWs.readyState !== WebSocket.OPEN) return;

            greetingSent = true;

            openAiWs.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["audio", "text"],
                    instructions: "Diga exatamente: Olá, como posso te ajudar?"
                }
            }));

            console.log("Greeting requested");
        }

        openAiWs.on("open", () => {
            console.log("OpenAI connected");
        });

        openAiWs.on("message", (data) => {
            let msg;

            try {
                msg = JSON.parse(data.toString());
            } catch (err) {
                console.log("Invalid OpenAI JSON:", err.message);
                return;
            }

            if (msg.type) {
                console.log("OpenAI event:", msg.type);
            }

            if (msg.type === "session.created") {
                openAiWs.send(JSON.stringify({
                    type: "session.update",
                    session: {
                        input_audio_format: "g711_ulaw",
                        output_audio_format: "g711_ulaw",
                        voice: "marin",
                        modalities: ["audio", "text"],
                        temperature: 0.7,
                        instructions: "Você é um assistente de voz em português do Brasil. Fale de forma curta, clara e natural.",
                        turn_detection: {
                            type: "server_vad",
                            silence_duration_ms: 500,
                            prefix_padding_ms: 300,
                            threshold: 0.5,
                            create_response: true
                        }
                    }
                }));
            }

            if (msg.type === "session.updated") {
                sessionReady = true;
                console.log("Session ready");
                maybeSendGreeting();
            }

            if (msg.type === "response.audio.delta" && msg.delta && streamSid) {
                console.log("Audio delta received");

                const chunk = Buffer.from(msg.delta, "base64");
                audioBuffer = Buffer.concat([audioBuffer, chunk]);

                while (audioBuffer.length >= 160) {
                    const frame = audioBuffer.subarray(0, 160);
                    audioBuffer = audioBuffer.subarray(160);

                    connection.send(JSON.stringify({
                        event: "media",
                        streamSid: streamSid,
                        media: {
                            payload: frame.toString("base64")
                        }
                    }));
                }
            }

            if (msg.type === "response.done") {
                console.log("Response done");
            }

            if (msg.type === "error") {
                console.log("OpenAI error:", JSON.stringify(msg));
            }
        });

        openAiWs.on("close", () => {
            console.log("OpenAI socket closed");
        });

        openAiWs.on("error", (err) => {
            console.log("OpenAI socket error:", err.message);
        });

        connection.on("message", (message) => {
            let data;

            try {
                data = JSON.parse(message.toString());
            } catch (err) {
                console.log("Invalid Twilio JSON:", err.message);
                return;
            }

            switch (data.event) {
                case "start":
                    streamSid = data.start.streamSid;
                    console.log("Stream started:", streamSid);
                    maybeSendGreeting();
                    break;

                case "media":
                    if (openAiWs.readyState === WebSocket.OPEN && data.media && data.media.payload) {
                        openAiWs.send(JSON.stringify({
                            type: "input_audio_buffer.append",
                            audio: data.media.payload
                        }));
                    }
                    break;

                case "stop":
                    console.log("Twilio stop event");
                    break;

                case "mark":
                    break;

                default:
                    console.log("Twilio event:", data.event);
                    break;
            }
        });

        connection.on("close", () => {
            console.log("Client disconnected");
            if (openAiWs.readyState === WebSocket.OPEN) {
                openAiWs.close();
            }
        });

        connection.on("error", (err) => {
            console.log("Twilio socket error:", err.message);
        });
    });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log("Server running on port " + PORT);
});
