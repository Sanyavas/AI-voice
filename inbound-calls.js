import WebSocket from "ws";

export function registerInboundRoutes(fastify) {
  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = process.env;
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
  }

  async function getSignedUrl() {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      { headers: { "xi-api-key": ELEVENLABS_API_KEY } }
    );
    if (!res.ok) throw new Error(`Failed to get signed URL: ${res.statusText}`);
    return (await res.json()).signed_url;
  }

  fastify.all("/incoming-call-eleven", async (req, reply) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${req.headers.host}/media-stream" />
        </Connect>
      </Response>`;
    reply.type("text/xml").send(xml);
  });

  fastify.register(async (instance) => {
    instance.get("/media-stream", { websocket: true }, async (conn) => {
      let streamSid = null, elevenWs = null;

      try {
        const signedUrl = await getSignedUrl();
        elevenWs = new WebSocket(signedUrl);

        elevenWs.on("open", () => {
          // стартовий prompt для ElevenLabs
          const init = {
            type: "conversation_initiation_client_data",
            conversation_config_override: {
              agent: { prompt: { prompt: "Привіт! Я ШІ‐асистент. Як я можу допомогти?" } }
            }
          };
          elevenWs.send(JSON.stringify(init));
        });

        elevenWs.on("message", (data) => {
          const msg = JSON.parse(data);
          if (msg.type === "audio" && msg.audio_event?.audio_base_64 && streamSid) {
            conn.send(
              JSON.stringify({ event: "media", streamSid, media: { payload: msg.audio_event.audio_base_64 } })
            );
          }
          if (msg.type === "interruption" && streamSid) {
            conn.send(JSON.stringify({ event: "clear", streamSid }));
          }
          if (msg.type === "ping" && msg.ping_event?.event_id) {
            elevenWs.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id }));
          }
        });

        elevenWs.on("error", (e) => console.error("[II] WebSocket error:", e));
        elevenWs.on("close", () => console.log("[II] Disconnected."));

        conn.on("message", (raw) => {
          const data = JSON.parse(raw);
          if (data.event === "start") {
            streamSid = data.start.streamSid;
            console.log(`[Twilio] Stream started: ${streamSid}`);
          }
          if (data.event === "media" && elevenWs?.readyState === WebSocket.OPEN) {
            elevenWs.send(JSON.stringify({ user_audio_chunk: data.media.payload }));
          }
          if (data.event === "stop" && elevenWs) {
            elevenWs.close();
          }
        });

        conn.on("close", () => {
          if (elevenWs) elevenWs.close();
          console.log("[Twilio] Client disconnected");
        });
        conn.on("error", (e) => {
          console.error("[Twilio] WebSocket error:", e);
          if (elevenWs) elevenWs.close();
        });
      } catch (e) {
        console.error("[Server] Initialization error:", e);
        if (elevenWs) elevenWs.close();
        conn.socket.close();
      }
    });
  });
}
