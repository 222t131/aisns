const express = require('express');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const path = require('path');
const admin = require('firebase-admin');
const Buffer = require('buffer').Buffer;
const cors = require('cors');

// Node.js v22でネイティブfetchを使用
const fetch = global.fetch; 
// Gemini SDK
const { GoogleGenerativeAI } = require('@google/generative-ai');

// 💡 Admin SDKの安定版構文を使用
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');


dotenv.config();

const app = express();
const port = process.env.PORT || 3000; 

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); 
app.use(express.static(path.join(__dirname, "dist")));



let db;
let storage;
try {
    const FIREBASE_BUCKET = process.env.FIREBASE_BUCKET || 'aisns-c95cf.appspot.com'; 
    
    // アプリケーションの初期化
    if (admin.apps.length === 0) {
        // Renderは環境変数 PROJECT_ID を使うため、ここでは引数なしで初期化を試みる
        admin.initializeApp({
            storageBucket: FIREBASE_BUCKET,
        });
        console.log(`✅ Firebase Admin SDK 初期化完了。`);
    }
    
    // サービスインスタンスの取得 (安定版の getFirestore/getStorage を使用)
    db = getFirestore(); 
    storage = getStorage().bucket();

} catch (e) {
    console.error(`🚨 Firebase Admin SDK 初期化失敗: ${e.message}`, e.stack);
    db = undefined;
    storage = undefined;
}



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



app.post('/api/transform',async(req,res) => {
    if (!db) { return res.status(500).json({ error: "Firestoreが初期化されていません。" }); }
    try{
        const userText = req.body.text;
        
        const prompt =`
            言葉を「ユーモア溢れる一言とイラスト案」に変換するプロンプト
            ... (プロンプトは省略)
            
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
        
        console.log("🔍 Gemini raw response:", responseText);

        let parsed;
        try {
            const cleanResponse = responseText.replace(/```json\s*|```\s*/g, '').trim();
            parsed = JSON.parse(cleanResponse);
        } catch (err) {
            console.error("🚨 JSON parse error: AIの応答がJSON形式ではありませんでした。", responseText);
            return res.status(500).json({ error: "AIのレスポンスをJSONに変換できませんでした" });
        }

        return res.json(parsed);
    }catch(error){
        console.error("🚨 Gemini API failed:", error);
        res.status(500).json({error:"テキストの変換に失敗"});
    }
});



app.post('/api/generate-image', async (req, res) => {
    if (!db) { return res.status(500).json({ error: "Firestoreが初期化されていません。" }); }
    try{
        if (!process.env.OPENAI_API_KEY) {
             return res.status(500).json({ error: "OPENAI_API_KEYが設定されていません。" });
        }

        const { imagePrompt } = req.body;
        console.log(`🖼️ Generating image with prompt: ${imagePrompt}`);

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
            
            if (data.error && data.error.message.includes("Billing hard limit")) {
                return res.status(403).json({ error: "課金上限に達しました。OpenAIで支払い設定をご確認ください。" });
            }

            return res.status(openaiResponse.status || 500).json({ error: errorMessage });
        }

        if (!data.data || data.data.length === 0) {
            return res.status(500).json({ error: "画像生成に失敗しました。OpenAIから画像データが得られませんでした。" });
        }

        const base64Image = data.data[0].b64_json; 
        res.json({ image: base64Image });
        
    } catch (error) {
        console.error("🚨 DALL-E API failed:", error.message || error);
        res.status(500).json({ error: "画像生成APIでエラーが発生しました。" });
    }
});



app.post('/api/archive', async (req, res) => {
    if (!db || !storage) {
        return res.status(500).json({ error: "FirestoreまたはStorageが初期化されていません。" });
    }

    try {
        const { originalText, friendlyText, imagePrompt, base64Image } = req.body;
        
        let imageUrl = null;

        if (base64Image) {
            console.log("📤 Base64データをStorageにアップロード開始...");
            
            const imageBuffer = Buffer.from(base64Image, 'base64');
            
            const fileExtension = 'jpeg'; 
            const fileName = `images/${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExtension}`;
            const file = storage.file(fileName);

            await file.save(imageBuffer, {
                metadata: {
                    contentType: `image/${fileExtension}`,
                },
                public: true, 
                validation: 'crc32c',
            });

            // StorageBucketの値をFirebase Admin SDKから取得
            const bucketName = admin.app().options.storageBucket;
            // 公開URLを取得
            imageUrl = `https://storage.googleapis.com/${bucketName}/${fileName}`;
            console.log(`✅ 画像をStorageに保存完了: ${imageUrl}`);
        }

        // Firestoreへの保存処理
        const collectionRef = db.collection('artwork_archives'); 

        const docRef = await collectionRef.add({
            originalText,
            friendlyText,
            imagePrompt,
            imageUrl: imageUrl, 
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ success: true, id: docRef.id });

    } catch (error) {
        console.error("🚨 Firestore保存失敗:", error);
        res.status(500).json({ error: "アーカイブ保存中にエラーが発生しました。" });
    }
});


app.get('/api/archives', async (req, res) => {
    if (!db) {
        return res.status(500).json({ error: "Firestoreが初期化されていません。" });
    }

    try {
        const snapshot = await db.collection('artwork_archives')
                                 .orderBy('timestamp', 'desc')
                                 .limit(20) 
                                 .get();

        const archives = [];
        snapshot.forEach(doc => {
            archives.push({ id: doc.id, ...doc.data() });
        });

        res.json(archives);

    } catch (error) {
        console.error("🚨 Firestore取得失敗:", error);
        res.status(500).json({ error: "アーカイブ取得中にエラーが発生しました。" });
    }
});



app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "dist", "index.html")); 
});


app.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}`);
});