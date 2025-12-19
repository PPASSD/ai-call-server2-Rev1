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
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${encodeURIComponent(
        ELEVENLABS_AGENT_ID
      )}`,
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
    // Twilio will open a websocket to /media-stream on YOUR server
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

      /** ElevenLabs websocket */
      let elevenWs = null;

      /** Gate starting the convo until Twilio start event arrives */
      let twilioStarted = false;
      let elevenOpen = false;
      let convoStarted = false;

      /** Simple counters for debugging */
      let twilioInboundFrames = 0;
      let twilioOutboundFrames = 0;

      function tryStartConversation() {
        // Start only when BOTH: Twilio has streamSid AND ElevenLabs WS is open
        if (convoStarted) return;
        if (!twilioStarted || !streamSid) return;
        if (!elevenWs || elevenWs.readyState !== WebSocket.OPEN) return;
        if (!elevenOpen) return;

        convoStarted = true;

        // 🔑 Start the agent speaking first
        // (ElevenLabs expects a "start" to begin the conversation)
        elevenWs.send(JSON.stringify({ type: "start" }));
        console.log("[II] Sent start to ElevenLabs (agent should speak).");
      }

      try {
        // 1️⃣ Get ElevenLabs signed URL
        const signedUrl = await getSignedUrl();
        console.log("[II] Signed URL acquired.");

        // 2️⃣ Connect to ElevenLabs
        elevenWs = new WebSocket(signedUrl);

        elevenWs.on("open", () => {
          elevenOpen = true;
          console.log("[II] Connected to Conversational AI.");

          // 🔑 CRITICAL: Tell ElevenLabs to send Twilio-compatible audio
          elevenWs.send(
            JSON.stringify({
              type: "conversation_config",
              conversation_config: {
                audio: {
                  output: {
                    encoding: "mulaw",
                    sample_rate: 8000
                  }
                }
              }
            })
          );

          console.log("[II] Sent conversation_config (mulaw/8000).");

          // If Twilio already started, start conversation now
          tryStartConversation();
        });

        elevenWs.on("message", (raw) => {
          let msg;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            return;
          }

          // Helpful debug (don’t spam audio payload)
          if (
            msg.type &&
            msg.type !== "audio" &&
            msg.type !== "ping" &&
            msg.type !== "partial_transcript"
          ) {
            console.log("[II] Message type:", msg.type);
          }

          // ONLY send valid audio frames to Twilio
          if (msg.type === "audio" && msg.audio_event?.audio_base_64) {
            if (!streamSid) {
              // Twilio will reject without streamSid, so drop safely.
              return;
            }

            const twilioFrame = {
              event: "media",
              streamSid,
              media: { payload: msg.audio_event.audio_base_64 }
            };

            try {
              connection.send(JSON.stringify(twilioFrame));
              twilioOutboundFrames++;
              if (twilioOutboundFrames % 25 === 0) {
                console.log(
                  `[Twilio<-] Sent ${twilioOutboundFrames} audio frames to Twilio`
                );
              }
            } catch (e) {
              console.error("[Twilio<-] Failed to send audio to Twilio:", e?.message || e);
            }
          }

          // Handle interruption safely (Twilio "clear" is valid)
          if (msg.type === "interruption" && streamSid) {
            connection.send(
              JSON.stringify({
                event: "clear",
                streamSid
              })
            );
          }
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
            streamSid = data.start?.streamSid || null;
            twilioStarted = true;
            console.log(`[Twilio] Stream started: ${streamSid}`);

            // Now that we have streamSid, we can start the conversation
            tryStartConversation();
            return;
          }

          if (data.event === "media") {
            if (
              elevenWs &&
              elevenWs.readyState === WebSocket.OPEN &&
              data.media?.payload
            ) {
              // Forward caller audio to ElevenLabs
              elevenWs.send(
                JSON.stringify({
                  user_audio_chunk: data.media.payload
                })
              );

              twilioInboundFrames++;
              if (twilioInboundFrames % 50 === 0) {
                console.log(
                  `[Twilio->] Received ${twilioInboundFrames} audio frames from Twilio`
                );
              }
            }
          }

          if (data.event === "stop") {
            console.log("[Twilio] Stream stopped.");
            if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
              elevenWs.close();
            }
          }
        });

        connection.on("close", () => {
          console.log("[Twilio] Client disconnected.");
          if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
            elevenWs.close();
          }
        });

        connection.on("error", (err) => {
          console.error("[Twilio] WS error:", err.message);
          if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
            elevenWs.close();
          }
        });
      } catch (err) {
        console.error(
          "[Server] Failed to initialize conversation:",
          err?.message || err
        );
        if (elevenWs && elevenWs.readyState === WebSocket.OPEN) {
          elevenWs.close();
        }
        if (connection?.socket) {
          connection.socket.close();
        }
      }
    });
  });
}
