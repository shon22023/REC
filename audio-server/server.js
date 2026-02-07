


/*

===== 起動方法 =======

cd audio-server
npm install
npm start

=====

*/










import express from "express";
import multer from "multer";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import cron from "node-cron";
import { v4 as uuidv4 } from "uuid";

// __dirname の代替（ESモジュール用）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== 設定 ======
const PORT = process.env.PORT || 3000;
const UPVOICE_DIR = path.join(__dirname, "upVoice");
const MIXED_VOICE_DIR = path.join(__dirname, "mixedVoice");
const MAX_FILES = 50;           // upVoice の上限ファイル数
const MIX_CANDIDATE_COUNT = 10; // ミックス対象の最大ファイル数
const MAX_MIXED_FILES = 2;      // 最新2つのミックス音声を保持
const MIXED_FILE_LIFETIME = 30 * 60 * 1000; // 30分

// ====== アプリ初期化 ======
const app = express();
app.use(cors());
app.use(express.json());


// upVoice フォルダが存在しなければ作成
if (!fs.existsSync(UPVOICE_DIR)) {
  fs.mkdirSync(UPVOICE_DIR, { recursive: true });
}

// mixedVoice フォルダが存在しなければ作成
if (!fs.existsSync(MIXED_VOICE_DIR)) {
  fs.mkdirSync(MIXED_VOICE_DIR, { recursive: true });
}

// ====== 状態管理 ======
let isMixing = false;         // FFmpeg amix 実行中フラグ（ロック機構）

// ====== Multer 設定（時刻付きファイル名で保存） ======
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPVOICE_DIR);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const uniqueId = uuidv4().slice(0, 8);
    const ext = path.extname(file.originalname) || ".webm";
    cb(null, `${timestamp}_${uniqueId}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB 上限
  },
  fileFilter: (req, file, cb) => {
    // 音声ファイルのみ許可
    if (file.mimetype.startsWith("audio/")) {
      cb(null, true);
    } else {
      cb(new Error("音声ファイルのみアップロード可能です"), false);
    }
  }
});

// ====== ヘルパー関数 ======

/**
 * upVoice フォルダ内のファイル一覧を取得（古い順にソート）
 */
function getUpVoiceFiles() {
  try {
    const files = fs.readdirSync(UPVOICE_DIR)
      .filter(f => !f.startsWith(".")) // 隠しファイル除外
      .map(f => ({
        name: f,
        path: path.join(UPVOICE_DIR, f),
        timestamp: parseInt(f.split("_")[0]) || 0
      }))
      .sort((a, b) => a.timestamp - b.timestamp); // 古い順
    return files;
  } catch (error) {
    console.error("ファイル一覧取得エラー:", error);
    return [];
  }
}

/**
 * ファイル数が上限を超えた場合、古いファイルを削除
 */
function enforceFileLimit() {
  const files = getUpVoiceFiles();
  if (files.length > MAX_FILES) {
    const toDelete = files.slice(0, files.length - MAX_FILES);
    toDelete.forEach(f => {
      try {
        fs.unlinkSync(f.path);
        console.log(`上限超過のため削除: ${f.name}`);
      } catch (err) {
        console.error(`削除エラー: ${f.name}`, err);
      }
    });
  }
}

/**
 * upVoice フォルダ内のすべてのファイルを削除
 */
function clearAllUpVoiceFiles() {
  const files = getUpVoiceFiles();
  files.forEach(f => {
    try {
      fs.unlinkSync(f.path);
      console.log(`削除: ${f.name}`);
    } catch (err) {
      console.error(`削除エラー: ${f.name}`, err);
    }
  });
  console.log(`upVoice 全削除完了 (${files.length}件)`);
}


/**
 * mixedVoice フォルダ内のファイル一覧を取得（新しい順にソート）
 */
function getMixedVoiceFiles() {
  try {
    const files = fs.readdirSync(MIXED_VOICE_DIR)
      .filter(f => !f.startsWith(".")) // 隠しファイル除外
      .map(f => ({
        name: f,
        path: path.join(MIXED_VOICE_DIR, f),
        timestamp: parseInt(f.split("_")[1]) || 0
      }))
      .sort((a, b) => b.timestamp - a.timestamp); // 新しい順
    return files;
  } catch (error) {
    console.error("mixedVoiceファイル一覧取得エラー:", error);
    return [];
  }
}

/**
 * 古いミックス音声を削除（30分以上経過 or MAX_MIXED_FILES超過）
 */
function cleanupOldMixedFiles() {
  const files = getMixedVoiceFiles();
  const now = Date.now();
  let deletedCount = 0;

  files.forEach((f, index) => {
    const age = now - f.timestamp;
    
    // 30分以上経過したファイルを削除
    if (age > MIXED_FILE_LIFETIME) {
      try {
        fs.unlinkSync(f.path);
        console.log(`期限切れミックス音声削除: ${f.name} (${Math.floor(age / 60000)}分経過)`);
        deletedCount++;
      } catch (err) {
        console.error(`削除エラー: ${f.name}`, err);
      }
    }
    // MAX_MIXED_FILES を超えた古いファイルも削除
    else if (index >= MAX_MIXED_FILES) {
      try {
        fs.unlinkSync(f.path);
        console.log(`上限超過ミックス音声削除: ${f.name}`);
        deletedCount++;
      } catch (err) {
        console.error(`削除エラー: ${f.name}`, err);
      }
    }
  });

  if (deletedCount > 0) {
    console.log(`ミックス音声クリーンアップ完了: ${deletedCount}件削除`);
  }
}

/**
 * upVoice内のファイルをamixしてmixedVoiceに保存
 */
async function performAutoMix() {
  // ロック確認（同時実行防止）
  if (isMixing) {
    console.log("既にミックス処理中です。スキップします。");
    return;
  }

  const files = getUpVoiceFiles();
  
  if (files.length === 0) {
    console.log("ミックスする音声がありません。");
    return;
  }

  isMixing = true;
  const timestamp = Date.now();
  const outputFilename = `mixed_${timestamp}.webm`;
  const outputPath = path.join(MIXED_VOICE_DIR, outputFilename);

  try {
    console.log(`自動ミックス開始: ${files.length}件のファイルを処理`);

    // ファイルが1つの場合はコピーするだけ
    if (files.length === 1) {
      fs.copyFileSync(files[0].path, outputPath);
      console.log(`単一ファイルをコピー: ${outputFilename}`);
      
      // upVoice内のファイルを削除
      clearAllUpVoiceFiles();
      isMixing = false;
      return;
    }

    // 複数ファイルをFFmpegでミックス
    const inputArgs = [];
    files.forEach(f => {
      inputArgs.push("-i", f.path);
    });

    const filterComplex = `amix=inputs=${files.length}:duration=longest:dropout_transition=2`;

    const ffmpegArgs = [
      ...inputArgs,
      "-filter_complex", filterComplex,
      "-ac", "2",           // ステレオ
      "-ar", "44100",       // サンプルレート
      "-f", "webm",         // 出力フォーマット
      "-c:a", "libopus",    // コーデック
      outputPath
    ];

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    let stderrBuffer = '';

    ffmpeg.stderr.on("data", (data) => {
      const message = data.toString();
      stderrBuffer += message;
      if (message.includes('Error') || message.includes('error') || message.includes('Invalid')) {
        console.error(`FFmpeg stderr: ${message}`);
      }
    });

    await new Promise((resolve, reject) => {
      ffmpeg.on("close", (code) => {
        if (code === 0) {
          console.log(`自動ミックス完了: ${outputFilename}`);
          // upVoice内のファイルを削除
          clearAllUpVoiceFiles();
          resolve();
        } else {
          console.error(`FFmpeg 終了コード: ${code}`);
          console.error(`FFmpeg stderr:\n${stderrBuffer}`);
          reject(new Error(`FFmpeg処理が失敗しました (終了コード: ${code})`));
        }
      });

      ffmpeg.on("error", (err) => {
        console.error("FFmpeg 実行エラー:", err);
        reject(err);
      });
    });

  } catch (error) {
    console.error("自動ミックス処理エラー:", error);
    // エラー時も出力ファイルが中途半端に残っている場合は削除
    if (fs.existsSync(outputPath)) {
      try {
        fs.unlinkSync(outputPath);
        console.log("エラー時の不完全ファイルを削除しました");
      } catch (unlinkErr) {
        console.error("不完全ファイルの削除に失敗:", unlinkErr);
      }
    }
  } finally {
    isMixing = false;
  }
}

// ====== API エンドポイント ======

/**
 * POST /upload
 * クライアントから音声ファイルを受信し、upVoice に保存
 */
app.post("/upload", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "音声ファイルがありません" });
    }

    console.log(`音声受信: ${req.file.filename}`);
    
    // ファイル数上限チェック・削除
    enforceFileLimit();

    // ファイル数を確認して初回アップロード時は即座にamix実行
    const files = getUpVoiceFiles();
    
    // 初回アップロード（1ファイルのみ）の場合は即座にミックス実行
    if (files.length === 1) {
      console.log('初回アップロード検出 - 即座にミックス実行');
      // 非同期で実行（レスポンスをブロックしない）
      queueMicrotask(() => performAutoMix());
    }

    res.status(200).json({ 
      ok: true, 
      filename: req.file.filename 
    });
  } catch (error) {
    console.error("アップロードエラー:", error);
    res.status(500).json({ ok: false, error: "アップロード処理中にエラーが発生しました" });
  }
});

/**
 * GET /mix
 * mixedVoice から最新のミックス音声を返却
 */
app.get("/mix", async (req, res) => {
  try {
    const mixedFiles = getMixedVoiceFiles();
    
    if (mixedFiles.length === 0) {
      return res.status(404).json({ ok: false, error: "ミックス音声がありません" });
    }

    // 最新のミックス音声を取得
    const latestMixed = mixedFiles[0];
    
    console.log(`ミックス音声配信: ${latestMixed.name}`);
    
    // ファイルサイズを取得
    const stats = fs.statSync(latestMixed.path);
    const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`ファイルサイズ: ${fileSizeMB}MB`);
    
    // ヘッダーを設定
    res.setHeader("Content-Type", "audio/webm");
    res.setHeader("Content-Disposition", "attachment; filename=mixed.webm");
    res.setHeader("Content-Length", stats.size);
    
    // ファイルをストリーミング
    const stream = fs.createReadStream(latestMixed.path);
    
    stream.on("error", (err) => {
      console.error("ストリームエラー:", err);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "ファイル読み込みエラー" });
      } else {
        res.destroy();
      }
    });
    
    stream.pipe(res);
    
  } catch (error) {
    console.error("ミックス音声配信エラー:", error);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "ミックス音声の配信中にエラーが発生しました" });
    }
  }
});

/**
 * GET /status
 * デバッグ用：サーバーの状態を返す
 */
app.get("/status", (req, res) => {
  const upVoiceFiles = getUpVoiceFiles();
  const mixedFiles = getMixedVoiceFiles();
  res.json({
    ok: true,
    upVoice: {
      totalFiles: upVoiceFiles.length,
      files: upVoiceFiles.map(f => f.name)
    },
    mixedVoice: {
      totalFiles: mixedFiles.length,
      files: mixedFiles.map(f => ({
        name: f.name,
        age: Math.floor((Date.now() - f.timestamp) / 60000) + "分"
      }))
    },
    isMixing
  });
});

/**
 * DELETE /clear
 * 手動で upVoice を全削除（デバッグ/管理用）
 */
app.delete("/clear", (req, res) => {
  clearAllUpVoiceFiles();
  res.json({ ok: true, message: "upVoice 全削除完了" });
});

// ====== スケジュールタスク ======

// 10分ごとに自動ミックス実行
cron.schedule("*/10 * * * *", async () => {
  console.log("=== 10分ごとの自動ミックス実行 ===");
  await performAutoMix();
});

// 30分ごとに古いミックス音声を削除
cron.schedule("*/30 * * * *", () => {
  console.log("=== 30分ごとのミックス音声クリーンアップ実行 ===");
  cleanupOldMixedFiles();
});

// 毎日6時に全削除（保険）
cron.schedule("0 6 * * *", () => {
  console.log("=== 毎日6時の全削除実行 ===");
  clearAllUpVoiceFiles();
  cleanupOldMixedFiles();
});

// ====== サーバー起動 ======
app.listen(PORT, () => {
  console.log(`🎙️ 録音サーバー起動: http://localhost:${PORT}`);
  console.log(`📁 upVoice ディレクトリ: ${UPVOICE_DIR}`);
  console.log(`📁 mixedVoice ディレクトリ: ${MIXED_VOICE_DIR}`);
  console.log(`📊 upVoice上限: ${MAX_FILES}件`);
  console.log(`🎵 ミックス音声保持: 最大${MAX_MIXED_FILES}件`);
  console.log(`⏰ 自動ミックス: 10分ごと + 初回即座実行`);
  console.log(`🧹 クリーンアップ: 30分ごと（${MIXED_FILE_LIFETIME / 60000}分経過で削除）`);
  console.log("==========================================");
});
