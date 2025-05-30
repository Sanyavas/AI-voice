import WebSocket from "ws";
import Twilio from "twilio";

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

  // Initialize Twilio client
  const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  // Helper function to get signed URL for authenticated conversations
  async function getSignedUrl() {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: 'GET',
        headers: { 'xi-api-key': ELEVENLABS_API_KEY }
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  }

  // Route to initiate outbound calls (password-protected)
  fastify.post("/outbound-call", async (request, reply) => {
    const { number, password } = request.body;

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
        url: `https://${request.headers.host}/outbound-call-twiml`
      });

      reply.send({
        success: true,
        message: "Call initiated",
        callSid: call.sid
      });
    } catch (error) {
      // Handle Twilio geo-permissions error specifically
      if (error.code === 21408) {
        console.error("Geographic permissions error:", error);
        return reply.code(403).send({
          success: false,
          error: "Account not authorized to call this destination. Enable permissions at https://www.twilio.com/console/voice/calls/geo-permissions/low-risk"
        });
      }
      // Log other errors and return message
      console.error("Error initiating outbound call:", error);
      reply.code(500).send({
        success: false,
        error: error.message || "Failed to initiate call"
      });
    }
  });

  // TwiML route for outbound calls
  fastify.all("/outbound-call-twiml", async (request, reply) => {
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream" />
        </Connect>
      </Response>`;

    reply.type("text/xml").send(twimlResponse);
  });

  // WebSocket route for handling media streams
  fastify.register(async (fastifyInstance) => {
    fastifyInstance.get("/outbound-media-stream", { websocket: true }, (ws) => {
      console.info("[Server] Twilio connected to outbound media stream");

      let streamSid = null;
      let callSid = null;
      let elevenLabsWs = null;

      ws.on('error', console.error);

      const setupElevenLabs = async () => {
        const signedUrl = await getSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on("open", () => {
          console.log("[ElevenLabs] Connected to Conversational AI");
          const initialConfig = { type: "conversation_initiation_client_data" };
          elevenLabsWs.send(JSON.stringify(initialConfig));
        });

        elevenLabsWs.on("message", (data) => {
          try {
            const message = JSON.parse(data);
            switch (message.type) {
              case "audio":
                if (streamSid && message.audio?.chunk) {
                  const audioData = { event: "media", streamSid, media: { payload: message.audio.chunk } };
                  ws.send(JSON.stringify(audioData));
                }
                break;
              case "interruption":
                if (streamSid) ws.send(JSON.stringify({ event: "clear", streamSid }));
                break;
              case "ping":
                if (message.ping_event?.event_id) {
                  elevenLabsWs.send(JSON.stringify({ type: "pong", event_id: message.ping_event.event_id }));
                }
                break;
            }
          } catch (e) {
            console.error("[ElevenLabs] Error processing message:", e);
          }
        });

        elevenLabsWs.on("error", console.error);
        elevenLabsWs.on("close", () => console.log("[ElevenLabs] Disconnected"));
      };

      setupElevenLabs();

      ws.on("message", (message) => {
        try {
          const msg = JSON.parse(message);
          switch (msg.event) {
            case "start":
              streamSid = msg.start.streamSid;
              callSid = msg.start.callSid;
              console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
              break;
            case "media":
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = { user_audio_chunk: msg.media.payload };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
              break;
            case "stop":
              console.log(`[Twilio] Stream ${streamSid} ended`);
              elevenLabsWs?.close();
              break;
          }
        } catch (e) {
          console.error("[Twilio] Error processing message:", e);
        }
      });

      ws.on("close", () => {
        console.log("[Twilio] Client disconnected");
        elevenLabsWs?.close();
      });
    });
  });
}
