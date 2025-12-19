import WebSocket from "ws";

/**
 * Registers inbound Twilio + ElevenLabs ConvAI routes
 */
export function registerInboundRoutes(fastify) {
  const { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID } = process.env;

  if (!ELEVENLABS_API_KEY || !ELEVENLABS_AGENT_ID) {
    throw new Error("Missing ELEVENLABS_API_KEY or ELEVENLABS_AGENT_ID");
  }

  /**
   * Get signed WebSocket URL from ElevenLabs
   */
  async function getSignedUrl() {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY
        }
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to get signed URL: ${res.status} ${text}`);
    }

    const json = await res.json();
    return json.signed_url;
  }

  /**
   * Twilio HTTP webhook (returns TwiML)
   */
  fastify.all("/incoming-call-eleven", async (req, reply) => {
    const twiml = `
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>`.trim();

    reply.type("text/xml").send(twiml);
  });

  /**
   * WebSocket bridge: Twilio <-> ElevenLabs
   */
  fastify.register(async function (fastifyWs) {
    fastifyWs.get("/media-stream", { websocket: true }, async (connection) => {
      console.log("[Server] Twilio connected to media stream.");

      let streamSid = null;
      let elevenWs = null;

      try {
        // 1️⃣ Get ElevenLabs signed URL
        const signedUrl = await getSignedUrl();

        // 2️⃣ Connect to ElevenLabs
        elevenWs = new WebSocket(signedUrl);

       elevenWs.on("open", () => {
  console.log("[II] Connected to Conversational AI.");

  // 🔑 CRITICAL: Tell ElevenLabs to send Twilio-compatible audio
  elevenWs.send(JSON.stringify({
    type: "conversation_config",
    conversation_config: {
      audio: {
        output: {
          encoding: "mulaw",
          sample_rate: 8000
        }
      }
    }
  }));
});


        elevenWs.on("message", (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }

          // ONLY send valid audio frames to Twilio
          if (
            msg.type === "audio" &&
            msg.audio_event?.audio_base_64 &&
            streamSid
          ) {
            const twilioFrame = {
              event: "media",
              streamSid,
              media: {
                payload: msg.audio_event.audio_base_64
              }
            };

            connection.send(JSON.stringify(twilioFrame));
          }

          // Handle interruption safely
          if (msg.type === "interruption" && streamSid) {
            connection.send(JSON.stringify({
              event: "clear",
              streamSid
            }));
          }

          // Ignore metadata, ping, etc. (DO NOT forward)
        });

        elevenWs.on("close", () => {
          console.log("[II] ElevenLabs disconnected.");
        });

        elevenWs.on("error", (err) => {
          console.error("[II] ElevenLabs WS error:", err.message);
        });

        // 3️⃣ Handle Twilio -> Server messages
        connection.on("message", (raw) => {
          let data;
          try {
            data = JSON.parse(raw.toString());
          } catch {
            return;
          }

          if (data.event === "start") {
            streamSid = data.start.streamSid;
            console.log(`[Twilio] Stream started: ${streamSid}`);
            return;
          }

          if (data.event === "media") {
            if (
              elevenWs &&
              elevenWs.readyState === WebSocket.OPEN &&
              data.media?.payload
            ) {
              elevenWs.send(JSON.stringify({
                user_audio_chunk: data.media.payload
              }));
            }
          }

          if (data.event === "stop") {
            console.log("[Twilio] Stream stopped.");
            if (elevenWs) elevenWs.close();
          }
        });

        connection.on("close", () => {
          console.log("[Twilio] Client disconnected.");
          if (elevenWs) elevenWs.close();
        });

        connection.on("error", (err) => {
          console.error("[Twilio] WS error:", err.message);
          if (elevenWs) elevenWs.close();
        });

      } catch (err) {
        console.error("[Server] Failed to initialize conversation:", err.message);
        if (elevenWs) elevenWs.close();
        if (connection?.socket) connection.socket.close();
      }
    });
  });
}
