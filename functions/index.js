const admin = require('firebase-admin');
const functions = require('firebase-functions');
const Buffer = require('buffer').Buffer;

// Node.js v22のネイティブfetchを使用
const fetch = global.fetch; 
// AI SDKs
const { GoogleGenerativeAI } = require('@google/generative-ai');
// Firestore と Storage のサービスモジュールを require して使用
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');


// --------------------------------------------------------
// Firebase Admin SDK 初期化 (Functions 環境では自動認証)
// --------------------------------------------------------
let db;
let storage;
try {
    const FIREBASE_BUCKET = 'aisns-c95cf.appspot.com'; // 🚨 ご自身のバケット名に要修正
    
    if (admin.apps.length === 0) {
        // Functionsのサービスアカウント認証を利用
        admin.initializeApp({
            storageBucket: FIREBASE_BUCKET,
        });
        console.log(`✅ Firebase Admin SDK 初期化完了 (Functions 自動認証)。`);
    }
    
    // サービスインスタンスの取得
    db = getFirestore(); 
    storage = getStorage().bucket();

} catch (e) {
    console.error(`🚨 Firebase Admin SDK 初期化失敗: ${e.message}`, e.stack);
    db = undefined;
    storage = undefined;
}

// --------------------------------------------------------
// AI クライアントの初期化 (Secrets Manager経由でキーを取得)
// --------------------------------------------------------

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

const geminiModel = genAI.getGenerativeModel({
    model:'gemini-2.5-flash',
    config: {
        responseMimeType: "application/json",
        responseSchema: {
            type: "object",
            properties: {
                friendlyText: { type: "string" },
                imagePrompt: { type: "string" }
            },
            required: ["friendlyText", "imagePrompt"]
        },
    },
});


// --------------------------------------------------------
// 🚨 Functions の本体: ネイティブ HTTP リクエストハンドラ
// --------------------------------------------------------

exports.api = functions.https.onRequest(async (req, res) => {
    
    // 🚨 必須: CORS ヘッダーを強制的に設定し、ローカルからのアクセスを許可
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // OPTIONSメソッド (プリフライトリクエスト) に対応
    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }
    
    // ----------------------------------------------------
    // ルーティングの定義 (req.url を使ってパスを判断)
    // ----------------------------------------------------
    const url = req.url;
    const method = req.method;

    if (method === 'POST' && url.endsWith('/api/transform')) {
        // ----------------------------------------------------
        // 1. 文章変換エンドポイント (Gemini API)
        // ----------------------------------------------------
        try{
            if (!db) { return res.status(500).json({ error: "Firestoreが初期化されていません。" }); }
            const userText = req.body.text;
            
            // ... (プロンプトは省略) ...
            const prompt = `
                言葉を「ユーモア溢れる一言とイラスト案」に変換するプロンプト
                ... (プロンプト詳細は省略)
                **最重要指示:**
                いかなる説明や装飾も付けず、以下のJSON形式のみを出力してください。
                
                {"friendlyText": "ここに変換後の優しい言葉", "imagePrompt": "ここに画像生成用の英語プロンプト"}

                入力文: ${userText}
            `;

            const result = await geminiModel.generateContent(prompt);
            
            let responseText;
            if (typeof result.response.text === 'function') {
                responseText = result.response.text();
            } else {
                responseText = result.response.text;
            }
            
            let parsed;
            try {
                const cleanResponse = responseText.replace(/```json\s*|```\s*/g, '').trim();
                parsed = JSON.parse(cleanResponse);
            } catch (err) {
                return res.status(500).json({ error: "AIのレスポンスをJSONに変換できませんでした" });
            }

            return res.status(200).json(parsed);

        } catch (error) {
            console.error("🚨 Gemini API failed:", error);
            return res.status(500).json({error:"テキストの変換に失敗"});
        }
    } 
    
    else if (method === 'POST' && url.endsWith('/api/generate-image')) {
        // ----------------------------------------------------
        // 2. 画像生成エンドポイント (DALL-E API)
        // ----------------------------------------------------
        try{
            if (!db) { return res.status(500).json({ error: "Firestoreが初期化されていません。" }); }
            if (!process.env.OPENAI_API_KEY) { return res.status(500).json({ error: "OPENAI_API_KEYが設定されていません。" }); }

            const { imagePrompt } = req.body;

            const openaiResponse = await fetch('https://api.openai.com/v1/images/generations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'dall-e-3', 
                    prompt: imagePrompt,
                    n: 1,
                    size: '1024x1024',
                    response_format: 'b64_json'
                })
            });

            const data = await openaiResponse.json();

            if (openaiResponse.status !== 200 || data.error) {
                const errorMessage = data.error ? data.error.message : `API request failed with status ${openaiResponse.status}.`;
                console.error("🚨 OpenAI API Error:", errorMessage);
                return res.status(openaiResponse.status || 500).json({ error: errorMessage });
            }

            const base64Image = data.data[0].b64_json; 
            return res.status(200).json({ image: base64Image });

        } catch (error) {
            console.error("🚨 DALL-E API failed:", error.message || error);
            return res.status(500).json({ error: "画像生成APIでエラーが発生しました。" });
        }
    } 
    
    else if (method === 'POST' && url.endsWith('/api/archive')) {
        // ----------------------------------------------------
        // 3. アーカイブ保存エンドポイント (Firestore + Storage)
        // ----------------------------------------------------
        try {
            if (!db || !storage) { return res.status(500).json({ error: "FirestoreまたはStorageが初期化されていません。" }); }

            const { originalText, friendlyText, imagePrompt, base64Image } = req.body;
            
            let imageUrl = null;
            if (base64Image) {
                const imageBuffer = Buffer.from(base64Image, 'base64');
                const fileName = `images/${Date.now()}-${Math.random().toString(36).substring(2)}.jpeg`;
                const file = storage.file(fileName);

                await file.save(imageBuffer, { metadata: { contentType: `image/jpeg` }, public: true });

                const bucketName = admin.app().options.storageBucket;
                imageUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
            }

            const collectionRef = db.collection('artwork_archives'); 
            const docRef = await collectionRef.add({
                originalText,
                friendlyText,
                imagePrompt,
                imageUrl: imageUrl, 
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            });

            return res.status(200).json({ success: true, id: docRef.id });

        } catch (error) {
            console.error("🚨 Firestore保存失敗:", error);
            return res.status(500).json({ error: "アーカイブ保存中にエラーが発生しました。" });
        }
    } 
    
    else if (method === 'GET' && url.endsWith('/api/archives')) {
        // ----------------------------------------------------
        // 4. アーカイブ取得エンドポイント (Firestore)
        // ----------------------------------------------------
        try {
            if (!db) { return res.status(500).json({ error: "Firestoreが初期化されていません。" }); }
            
            const snapshot = await db.collection('artwork_archives')
                                     .orderBy('timestamp', 'desc')
                                     .limit(20) 
                                     .get();

            const archives = [];
            snapshot.forEach(doc => {
                archives.push({ id: doc.id, ...doc.data() });
            });

            return res.status(200).json(archives);

        } catch (error) {
            console.error("🚨 Firestore取得失敗:", error);
            return res.status(500).json({ error: "アーカイブ取得中にエラーが発生しました。" });
        }
    } 
    
    else {
        // 5. 404: マッチする API パスがない
        return res.status(404).json({ error: `API Endpoint Not Found: ${url}` });
    }
});