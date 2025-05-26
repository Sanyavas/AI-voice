import WebSocket from "ws";

export function registerInboundRoutes(fastify) {
  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    console.error("Missing required environment variables");
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
  }

  async function getSignedUrl() {
    try {
      const response = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
        {
          method: 'GET',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to get signed URL: ${response.statusText}`);
      }

      const data = await response.json();
      return data.signed_url;
    } catch (error) {
      console.error("Error getting signed URL:", error);
      throw error;
    }
  }

  fastify.all("/incoming-call-eleven", async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/media-stream" />
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/media-stream", { websocket: true }, async (connection, req) => {
      console.info("[Server] Twilio connected to media stream.");

      let streamSid = null;
      let elevenLabsWs = null;

      // Визначаємо функцію обробки повідомлень від ElevenLabs перед її використанням
      function handleElevenLabsMessage(message, connection) {
        switch (message.type) {
          case "conversation_initiation_metadata":
            console.info("[II] Received conversation initiation metadata.");
            break;
          case "audio":
            if (message.audio_event?.audio_base_64) {
              const audioData = {
                event: "media",
                streamSid,
                media: {
                  payload: message.audio_event.audio_base_64,
                },
              };
              connection.send(JSON.stringify(audioData));
            }
            break;
          case "interruption":
            connection.send(JSON.stringify({ event: "clear", streamSid }));
            break;
          case "ping":
            if (message.ping_event?.event_id) {
              const pongResponse = {
                type: "pong",
                event_id: message.ping_event.event_id,
              };
              elevenLabsWs.send(JSON.stringify(pongResponse));
            }
            break;
          default:
            console.log(`[II] Unhandled message type: ${message.type}`);
        }
      }

      try {
        const signedUrl = await getSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on("open", () => {
          console.log("[II] Connected to Conversational AI.");
        });

        elevenLabsWs.on("message", (data) => {
          try {
            const message = JSON.parse(data);
            handleElevenLabsMessage(message, connection);
          } catch (error) {
            console.error("[II] Error parsing message:", error);
          }
        });

        elevenLabsWs.on("error", (error) => {
          console.error("[II] WebSocket error:", error);
        });

        elevenLabsWs.on("close", () => {
          console.log("[II] Disconnected.");
        });

        connection.on("message", async (message) => {
          try {
            const data = JSON.parse(message);
            switch (data.event) {
              case "start":
                streamSid = data.start.streamSid;
                console.log(`[Twilio] Stream started with ID: ${streamSid}`);
                break;
              case "media":
                if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                  // Якщо аудіо вже в base64, можна відправити його напряму
                  const audioMessage = {
                    user_audio_chunk: data.media.payload
                  };
                  elevenLabsWs.send(JSON.stringify(audioMessage));
                }
                break;
              case "stop":
                if (elevenLabsWs) {
                  elevenLabsWs.close();
                }
                break;
              default:
                console.log(`[Twilio] Received unhandled event: ${data.event}`);
            }
          } catch (error) {
            console.error("[Twilio] Error processing message:", error);
          }
        });

        connection.on("close", () => {
          if (elevenLabsWs) {
            elevenLabsWs.close();
          }
          console.log("[Twilio] Client disconnected");
        });

        connection.on("error", (error) => {
          console.error("[Twilio] WebSocket error:", error);
          if (elevenLabsWs) {
            elevenLabsWs.close();
          }
        });
      } catch (error) {
        console.error("[Server] Error initializing conversation:", error);
        if (elevenLabsWs) {
          elevenLabsWs.close();
        }
        connection.socket.close();
      }
    });
  });
}
