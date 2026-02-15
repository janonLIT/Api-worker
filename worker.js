// Cloudflare Worker - OpenAI to NVIDIA NIM API Proxy

// 🔥 CONFIGURATION - Edit these settings
const SHOW_REASONING = true; // Set to true to show reasoning with <think> tags
const ENABLE_THINKING_MODE = true; // Set to true for models with thinking parameter

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Extract API key from Authorization header (from Janitor AI)
    const authHeader = request.headers.get('Authorization');
    let NIM_API_KEY = null;
    
    if (authHeader) {
      // Support both "Bearer xxx" and "xxx" formats
      NIM_API_KEY = authHeader.replace(/^Bearer\s+/i, '').trim();
    }

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle OPTIONS request
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        service: 'OpenAI to NVIDIA NIM Proxy (Cloudflare Workers)',
        reasoning_display: SHOW_REASONING,
        thinking_mode: ENABLE_THINKING_MODE,
        api_key_required: 'Pass your NVIDIA API key in Janitor AI settings'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Check if API key is provided for protected endpoints
    if (!NIM_API_KEY) {
      return new Response(JSON.stringify({
        error: {
          message: 'No API key provided. Please enter your NVIDIA API key in Janitor AI settings.',
          type: 'authentication_error',
          code: 401
        }
      }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // List models endpoint - returns available NIM models
    if (url.pathname === '/v1/models') {
      try {
        const response = await fetch(`${NIM_API_BASE}/models`, {
          headers: { 'Authorization': `Bearer ${NIM_API_KEY}` }
        });
        
        if (response.ok) {
          const data = await response.json();
          return new Response(JSON.stringify(data), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      } catch (e) {}
      
      // Fallback if models endpoint fails
      return new Response(JSON.stringify({
        object: 'list',
        data: [
          { id: 'meta/llama-3.1-405b-instruct', object: 'model', created: Date.now(), owned_by: 'nvidia' },
          { id: 'meta/llama-3.1-70b-instruct', object: 'model', created: Date.now(), owned_by: 'nvidia' },
          { id: 'meta/llama-3.1-8b-instruct', object: 'model', created: Date.now(), owned_by: 'nvidia' }
        ]
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Chat completions endpoint
    if (url.pathname === '/v1/chat/completions' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { model, messages, temperature, max_tokens, stream } = body;

        // Use the model name directly - no mapping needed!
        const nimModel = model;

        // Build NIM request
        const nimRequest = {
          model: nimModel,
          messages: messages,
          temperature: temperature || 0.6,
          max_tokens: max_tokens || 9024,
          stream: stream || false
        };

        if (ENABLE_THINKING_MODE) {
          nimRequest.extra_body = { chat_template_kwargs: { thinking: true } };
        }

        // Make request to NVIDIA NIM API
        const response = await fetch(`${NIM_API_BASE}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${NIM_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(nimRequest)
        });

        if (!response.ok) {
          const errorText = await response.text();
          return new Response(JSON.stringify({
            error: {
              message: errorText || 'NIM API error - check if your API key is valid',
              type: 'api_error',
              code: response.status
            }
          }), {
            status: response.status,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        if (stream) {
          // Handle streaming with reasoning - FIXED VERSION
          const { readable, writable } = new TransformStream();
          const writer = writable.getWriter();
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const encoder = new TextEncoder();
          
          let buffer = '';
          let reasoningStarted = false;

          (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                
                if (done) {
                  // Process any remaining data in buffer
                  if (buffer.trim().length > 0) {
                    const remainingLines = buffer.split('\n');
                    for (const line of remainingLines) {
                      if (line.trim().startsWith('data: ') && !line.includes('[DONE]')) {
                        try {
                          await writer.write(encoder.encode(line + '\n\n'));
                        } catch (e) {
                          console.error('Error writing remaining buffer:', e);
                        }
                      }
                    }
                  }
                  // Send final [DONE] marker
                  await writer.write(encoder.encode('data: [DONE]\n\n'));
                  break;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep last incomplete line in buffer

                for (const line of lines) {
                  if (!line.trim()) continue; // Skip empty lines
                  
                  if (line.startsWith('data: ')) {
                    if (line.includes('[DONE]')) {
                      await writer.write(encoder.encode(line + '\n\n'));
                      continue;
                    }

                    try {
                      const jsonStr = line.slice(6); // Remove 'data: ' prefix
                      const data = JSON.parse(jsonStr);
                      
                      if (data.choices?.[0]?.delta) {
                        const reasoning = data.choices[0].delta.reasoning_content;
                        const content = data.choices[0].delta.content;

                        if (SHOW_REASONING) {
                          let combinedContent = '';

                          if (reasoning && !reasoningStarted) {
                            combinedContent = '<think>\n' + reasoning;
                            reasoningStarted = true;
                          } else if (reasoning) {
                            combinedContent = reasoning;
                          }

                          if (content && reasoningStarted) {
                            combinedContent += '\n</think>\n\n' + content;
                            reasoningStarted = false;
                          } else if (content) {
                            combinedContent += content;
                          }

                          if (combinedContent) {
                            data.choices[0].delta.content = combinedContent;
                            delete data.choices[0].delta.reasoning_content;
                          }
                        } else {
                          // When not showing reasoning, just pass content
                          if (content) {
                            data.choices[0].delta.content = content;
                          } else {
                            data.choices[0].delta.content = '';
                          }
                          delete data.choices[0].delta.reasoning_content;
                        }
                      }
                      
                      await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                      
                    } catch (e) {
                      // If JSON parsing fails, pass line through as-is
                      console.error('JSON parse error:', e);
                      await writer.write(encoder.encode(line + '\n\n'));
                    }
                  }
                }
              }
            } catch (error) {
              console.error('Streaming error:', error);
              // Try to send error to client
              try {
                await writer.write(encoder.encode(`data: {"error": "${error.message}"}\n\n`));
                await writer.write(encoder.encode('data: [DONE]\n\n'));
              } catch (e) {
                console.error('Error writing error message:', e);
              }
            } finally {
              try {
                await writer.close();
              } catch (e) {
                console.error('Error closing writer:', e);
              }
            }
          })();

          return new Response(readable, {
            headers: {
              ...corsHeaders,
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive'
            }
          });
          }
           else {
          // Handle non-streaming with reasoning
          const data = await response.json();
          
          const openaiResponse = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: data.choices.map(choice => {
              let fullContent = choice.message?.content || '';

              if (SHOW_REASONING && choice.message?.reasoning_content) {
                fullContent = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + fullContent;
              }

              return {
                index: choice.index,
                message: {
                  role: choice.message.role,
                  content: fullContent
                },
                finish_reason: choice.finish_reason
              };
            }),
            usage: data.usage || {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0
            }
          };

          return new Response(JSON.stringify(openaiResponse), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

      } catch (error) {
        return new Response(JSON.stringify({
          error: {
            message: error.message || 'Internal server error',
            type: 'invalid_request_error',
            code: 500
          }
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // Catch-all for unsupported endpoints
    return new Response(JSON.stringify({
      error: {
        message: `Endpoint ${url.pathname} not found`,
        type: 'invalid_request_error',
        code: 404
      }
    }), {
      status: 404,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
};
