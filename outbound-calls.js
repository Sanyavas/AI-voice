import WebSocket from "ws";
import Twilio from "twilio";
import fetch from "node-fetch";

export function registerOutboundRoutes(fastify) {
  // Check for required environment variables
  const {
    ELEVENLABS_API_KEY,
    ELEVENLABS_AGENT_ID,
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER,
    OUTBOUND_CALL_PASSWORD
  } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !OUTBOUND_CALL_PASSWORD) {
    console.error("Missing required environment variables");
    throw new Error("Missing required environment variables");
  }

  const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

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

  // ✅ Outbound call endpoint with password check
  fastify.post("/outbound-call", async (request, reply) => {
    const { number, prompt, password } = request.body;

    if (!password || password !== OUTBOUND_CALL_PASSWORD) {
      return reply.code(401).send({ error: "Unauthorized: invalid password" });
    }

    if (!number) {
      return reply.code(400).send({ error: "Phone number is required" });
    }

    try {
      const call = await twilioClient.calls.create({
        from: TWILIO_PHONE_NUMBER,
        to: number,
        url: `https://${request.headers.host}/outbound-call-twiml?prompt=${encodeURIComponent(prompt || "")}`
      });

      reply.send({
        success: true,
        message: "Call initiated",
        callSid: call.sid
      });
    } catch (error) {
      console.error("Error initiating outbound call:", error);
      reply.code(500).send({
        success: false,
        error: "Failed to initiate call"
      });
    }
  });

  fastify.all("/outbound-call-twiml", async (request, reply) => {
    const prompt = request.query.prompt || '';

    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
          </Stream>
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/outbound-media-stream", { websocket: true }, (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;
      let customParameters = null;

      ws.on('error', console.error);

      const setupElevenLabs = async () => {
        try {
          const signedUrl = await getSignedUrl();
          elevenLabsWs = new WebSocket(signedUrl);

          elevenLabsWs.on("open", () => {
            console.log("[ElevenLabs] Connected to Conversational AI");

            const initialConfig = {
              type: "conversation_initiation_client_data",
              // conversation_config_override: {
              //   agent: {
              //     prompt: { prompt: customParameters?.prompt || "ти ШІ асистент" },
              //     first_message: "Привіт, як я можу допомогти?",
              //   }
              // }
            };

            elevenLabsWs.send(JSON.stringify(initialConfig));
          });

          elevenLabsWs.on("message", (data) => {
            try {
              const message = JSON.parse(data);

              switch (message.type) {
                case "conversation_initiation_metadata":
                  console.log("[ElevenLabs] Received initiation metadata");
                  break;
                  
                // Якщо агент ElevenLabs викликає tool "end_call", завершуємо дзвінок через Twilio API
                case "tool_use":
                  console.log("[DEBUG] tool_use message:", message);
                  if (message.tool_name === "end_call" && callSid) {
                    twilioClient.calls(callSid).update({ status: "completed" })
                      .then(() => console.log("[Twilio] Call ended via end_call tool"))
                      .catch((err) => console.error("[Twilio] Error ending call:", err));
                  }
                  break;

                case "audio":
                  if (streamSid) {
                    const payload = message.audio?.chunk || message.audio_event?.audio_base_64;
                    if (payload) {
                      ws.send(JSON.stringify({
                        event: "media",
                        streamSid,
                        media: { payload }
                      }));
                    }
                  }
                  break;

                case "interruption":
                  if (streamSid) {
                    ws.send(JSON.stringify({
                      event: "clear",
                      streamSid
                    }));
                  }
                  break;

                case "ping":
                  if (message.ping_event?.event_id) {
                    elevenLabsWs.send(JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id
                    }));
                  }
                  break;

                default:
                  console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
              }
            } catch (error) {
              console.error("[ElevenLabs] Error processing message:", error);
            }
          });

          elevenLabsWs.on("error", (error) => {
            console.error("[ElevenLabs] WebSocket error:", error);
          });

          elevenLabsWs.on("close", () => {
            console.log("[ElevenLabs] Disconnected");
          });

        } catch (error) {
          console.error("[ElevenLabs] Setup error:", error);
        }
      };

      setupElevenLabs();

      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          console.log(`[Twilio] Received event: ${msg.event}`);

          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              customParameters = msg.start.customParameters;
              console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
              break;

            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: Buffer.from(msg.media.payload, "base64").toString("base64")
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;

            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              break;

            default:
              console.log(`[Twilio] Unhandled event: ${msg.event}`);
          }
        } catch (error) {
          console.error("[Twilio] Error processing message:", error);
        }
      });

      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        if (elevenLabsWs?.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
        }
      });
    });
  });
}
