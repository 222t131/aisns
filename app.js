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
// 🚨 Render デプロイに必須: 環境変数 PORT を優先
const port = process.env.PORT || 3000; 

// 🚨 修正点: CORSとbodyParserはアプリの先頭で定義
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' })); 
app.use(express.static(path.join(__dirname, "dist")));


let db;
let storage;
try {
    const FIREBASE_BUCKET = process.env.FIREBASE_BUCKET || 'aisns-c95cf.appspot.com'; 
    
    // 認証情報ファイルを環境変数から取得
    const credentialsBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;
    
    if (admin.apps.length === 0) {
        if (credentialsBase64) {
            // Base64認証情報が存在する場合、デコードして使用
            const credentialsJson = Buffer.from(credentialsBase64, 'base64').toString('utf8');
            const credentials = JSON.parse(credentialsJson);

            admin.initializeApp({
                credential: admin.credential.cert(credentials),
                storageBucket: FIREBASE_BUCKET,
            });
            console.log(`✅ Firebase Admin SDK 初期化完了 (Base64認証)。`);
        } else {
            // Base64がない場合、Render環境変数 (PROJECT_ID) を使って初期化を試みる
            admin.initializeApp({
                storageBucket: FIREBASE_BUCKET,
            });
             console.log(`✅ Firebase Admin SDK 初期化完了 (自動認証)。`);
        }
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
            どうも、言葉のソムリエです。専門はキレのあるウィットと、隠し味のボケでございます。
            本日は特別に、私が仕立てた言葉を「視覚的な一皿」としてお楽しみいただくための**【盛り付けのレシピ（画像化プロンプト）】**まで、フルコースでご提供いたします。
            タスク概要:
            これから私（ユーザー）が入力する言葉を、以下の2点セットでご提案ください。
            1. 【ソムリエの一言】:思わずクスッと笑みがこぼれるような、気の利いた一言。
            2.【盛り付けのレシピ】:その一言をテーマにした、具体的な画像生成プロンプト。
            変換のルール:
            A.【ソムリエの一言】のルール
            1 感情の方向性に合わせた変換:
            ネガティブな言葉の場合:ポジティブな意味にひっくり返したり、少し斜め上の面白い視点に変換します。
            ポジティブな言葉の場合:元のポジティブな感情はそのままに、さらに気の利いた、あるいは少し照れ隠しを含んだような、味わい深い表現に昇華させます。
            2.【最重要】超簡潔スマート:変換後の文章は、元の文章とほぼ同じ単語数、またはそれ以下でお願いします。一言で言い放つような、キレの良さを追求してください。
            3.上品なユーモア:皮肉や気の利いた比喩を使い、知的で面白い文章を目指します。絵文字は１～２個に留め、品格を保ちます。
            4.隠し味のボケ:少しだけピントのずれたことを言ってみたり、あえて壮大な勘違いをしてみせたり。思わず「なんでだよ」と心の中でツッコミたくなるような、愛嬌のあるボケをそっと添えます。
            B.【盛り付けのレシピ（画像化プロンプト）】のルール**
            1.物語の1コマとして描写:「ソムリエの一言」が持つシュールな面白さを、具体的な「誰が・どこで・何をしている」という物語のワンシーンとして描写してください。
            2.面白さの核を強調:ユーモアのポイントを、視覚的なシンボル（例：光る時給アイコン）や、状況とのギャップ（例：本人は至って真顔）で強調してください。
            3.雰囲気のキーワード:comical, surreal, deadpan humor などのキーワードを用いて、イラストのスタイルや雰囲気を明確に指定してください。
            4.出力形式:日本語での具体的なシーン説明と、それを基にした英語のプロンプトの両方を提示してください。
            
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