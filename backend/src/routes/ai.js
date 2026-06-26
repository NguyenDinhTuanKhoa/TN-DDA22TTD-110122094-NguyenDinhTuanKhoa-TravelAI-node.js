const express = require('express');
const aiService = require('../services/aiService');
const { protect, optionalAuth } = require('../middleware/auth');
const { aiGuestLimiter, aiAuthLimiter } = require('../middleware/rateLimiter');
const ChatHistory = require('../models/ChatHistory');
const router = express.Router();

// ── Dynamic limiter cho /chat/stream: auth → 40/phút, guest → 15/phút ──────
const streamLimiter = (req, res, next) => {
  if (req.user) return aiAuthLimiter(req, res, next);
  return aiGuestLimiter(req, res, next);
};

/**
 * @swagger
 * /ai/history:
 *   get:
 *     summary: Lấy danh sách lịch sử chat
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Danh sách cuộc chat
 */
// Get all chat histories for user
router.get('/history', protect, async (req, res) => {
  try {
    const histories = await ChatHistory.find({ user: req.user._id })
      .select('_id title lastMessage createdAt')
      .sort({ lastMessage: -1 })
      .limit(50);
    res.json({ success: true, data: histories });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @swagger
 * /ai/history/{id}:
 *   get:
 *     summary: Lấy chi tiết cuộc chat
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Chi tiết cuộc chat với messages
 */
// Get single chat history
router.get('/history/:id', protect, async (req, res) => {
  try {
    const history = await ChatHistory.findOne({
      _id: req.params.id,
      user: req.user._id
    }).populate('messages.destinations', 'name images location category rating priceRange description');
    if (!history) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }
    res.json({ success: true, data: history });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @swagger
 * /ai/history:
 *   post:
 *     summary: Tạo cuộc chat mới
 *     tags: [AI]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Tạo thành công
 */
// Create new chat
router.post('/history', protect, async (req, res) => {
  try {
    const chat = await ChatHistory.create({
      user: req.user._id,
      messages: []
    });
    res.status(201).json({ success: true, data: chat });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// NOTE: Route POST /history/:id/message (non-streaming) đã được gỡ bỏ — frontend chỉ
// dùng /chat/stream (có clarification form, strip <think>, retry detection). Bản non-stream
// đã phân kỳ logic và không còn nơi nào gọi. Lưu lịch sử do /chat/stream tự xử lý.

// Delete chat history
router.delete('/history/:id', protect, async (req, res) => {
  try {
    const result = await ChatHistory.findOneAndDelete({ 
      _id: req.params.id, 
      user: req.user._id 
    });
    if (!result) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }
    res.json({ success: true, message: 'Chat deleted' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Rename chat
router.patch('/history/:id', protect, async (req, res) => {
  try {
    const { title } = req.body;
    const chat = await ChatHistory.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { title },
      { new: true }
    );
    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }
    res.json({ success: true, data: chat });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * @swagger
 * /ai/chat:
 *   post:
 *     summary: Chat với AI (không lưu lịch sử)
 *     tags: [AI]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - messages
 *             properties:
 *               messages:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     role:
 *                       type: string
 *                       enum: [user, assistant]
 *                     content:
 *                       type: string
 *     responses:
 *       200:
 *         description: Phản hồi từ AI
 */
// Chat với AI (non-streaming) - for guests
router.post('/chat', aiGuestLimiter, async (req, res) => {
  try {
    const { messages } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ message: 'Messages array is required' });
    }

    console.log('AI Chat request:', messages.length, 'messages');
    const response = await aiService.chatComplete(messages);
    console.log('AI Chat response received');
    res.json({ response });
  } catch (error) {
    console.error('AI Chat Error:', error.message);
    res.status(500).json({ message: 'AI service error', error: error.message });
  }
});

// Chat với AI (streaming) - hỗ trợ guest lẫn authenticated
// optionalAuth TRƯỚC streamLimiter để limiter biết user đã đăng nhập chưa (chọn quota đúng)
router.post('/chat/stream', optionalAuth, streamLimiter, async (req, res) => {
  try {
    const { messages, chatId } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ message: 'Messages array is required' });
    }

    // Set headers for SSE (CORS do middleware cors() toàn cục xử lý — không set tay '*')
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const userId = req.user?._id || null;
    let fullResponse = '';

    // Detect client disconnect DURING streaming (không nhầm với normal completion sau res.end())
    let clientAbortedMidStream = false;
    const onClose = () => {
      if (!res.writableEnded) clientAbortedMidStream = true;
    };
    req.on('close', onClose);

    // ── Lưu lượt chat vào lịch sử (dùng chung cho cả luồng AI lẫn clarification form) ──
    const saveTurn = async () => {
      if (!(req.user && chatId)) return;
      try {
        const chat = await ChatHistory.findOne({ _id: chatId, user: req.user._id });
        if (!chat) return;
        // Chỉ skip nếu client thật sự abort giữa chừng stream (không phải normal completion)
        if (clientAbortedMidStream) {
          console.warn('[Stream] Client disconnected mid-stream, skipping save for chatId:', chatId);
          return;
        }

        const lastMsg = messages[messages.length - 1];
        // Tránh duplicate: chỉ push user message nếu chưa có
        const alreadySaved = chat.messages.some(
          m => m.role === 'user' && m.content === lastMsg?.content
        );
        if (!alreadySaved && lastMsg?.role === 'user') {
          chat.messages.push({ role: 'user', content: lastMsg.content });
        }
        // Lọc bỏ <think>...</think> trước khi lưu vào DB
        const cleanResponse = fullResponse.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        // Chỉ save nếu response không rỗng (tránh save junk khi stream lỗi sớm)
        if (!cleanResponse) {
          console.warn('[Stream] Empty response, skipping save for chatId:', chatId);
          return;
        }
        // Trích điểm đến server-side (cùng hàm frontend dùng) → persist ID để khỏi
        // re-extract mỗi lần mở lại chat. Lỗi trích không được làm hỏng việc lưu chat.
        // BỎ QUA nếu response là FORM LÀM RÕ (json_form): nó không gợi ý điểm đến, và lời
        // mở đầu ("gợi ý bãi biển hợp ý") dễ khớp nhầm địa danh tên "Bãi biển".
        let destIds = [];
        if (!cleanResponse.includes('```json_form')) {
          try {
            // Kèm câu hỏi user để bỏ qua card khi đó là câu hỏi ngoài lề (kiến thức
            // chung / hành chính) — đồng bộ với gate ở /destinations/from-text.
            const userQ = lastMsg?.role === 'user' ? lastMsg.content : '';
            const dests = await aiService.extractMentionedDestinations(cleanResponse, 10, userQ);
            destIds = dests.map(d => d._id);
          } catch (e) {
            console.warn('[Stream] extract destinations failed:', e.message);
          }
        }
        // Retry detection: nếu user message đã tồn tại (alreadySaved) VÀ message cuối là assistant
        // → đây là retry của lần trước fail → REPLACE last assistant thay vì push mới
        const lastChatMsg = chat.messages[chat.messages.length - 1];
        if (alreadySaved && lastChatMsg?.role === 'assistant') {
          chat.messages[chat.messages.length - 1].content = cleanResponse;
          chat.messages[chat.messages.length - 1].destinations = destIds;
        } else {
          chat.messages.push({ role: 'assistant', content: cleanResponse, destinations: destIds });
        }
        await chat.save();
      } catch (saveErr) {
        console.error('[Stream] Error saving to history:', saveErr.message);
      }
    };

    // ── Clarification short-circuit (tất định, KHÔNG gọi model) ──
    // Yêu cầu mơ hồ (có ý định du lịch nhưng thiếu địa điểm) → trả về form làm rõ
    // ngay lập tức thay vì để model đoán đại.
    const clarifyBlock = await aiService.buildClarificationBlock(messages);
    if (clarifyBlock) {
      fullResponse = clarifyBlock;
      res.write(`data: ${JSON.stringify({ content: clarifyBlock })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      req.off('close', onClose);
      await saveTurn();
      return;
    }

    await aiService.chat(messages, (chunk) => {
      fullResponse += chunk;
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }, userId);

    res.write('data: [DONE]\n\n');
    res.end();
    req.off('close', onClose);

    // Lưu vào lịch sử nếu user đã đăng nhập và có chatId
    await saveTurn();
  } catch (error) {
    console.error('AI Stream Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'AI service error', error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

// Gợi ý lịch trình
router.post('/suggest-itinerary', protect, async (req, res) => {
  try {
    const { destination, days, budget, interests } = req.body;
    
    if (!destination || !days) {
      return res.status(400).json({ message: 'Destination and days are required' });
    }

    const suggestion = await aiService.suggestItinerary(
      destination,
      days,
      budget || 'trung bình',
      interests || ['khám phá']
    );

    res.json({ suggestion });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Gợi ý điểm đến
router.post('/suggest-destinations', protect, async (req, res) => {
  try {
    const { travelStyle, budget, interests, duration } = req.body;
    
    const suggestion = await aiService.suggestDestinations({
      travelStyle,
      budget,
      interests,
      duration
    });

    res.json({ suggestion });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

// Hỏi về điểm đến cụ thể
router.post('/ask-destination', async (req, res) => {
  try {
    const { destination, question } = req.body;
    
    if (!destination || !question) {
      return res.status(400).json({ message: 'Destination and question are required' });
    }

    const answer = await aiService.askAboutDestination(destination, question);
    res.json({ answer });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
});

module.exports = router;
