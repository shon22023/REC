


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
const MAX_FILES = 50;           // upVoice の上限ファイル数
const MIX_CANDIDATE_COUNT = 10; // ミックス対象の最大ファイル数

// ====== アプリ初期化 ======
const app = express();
app.use(cors());
app.use(express.json());


// upVoice フォルダが存在しなければ作成
if (!fs.existsSync(UPVOICE_DIR)) {
  fs.mkdirSync(UPVOICE_DIR, { recursive: true });
}

// ====== 状態管理 ======
let mixCandidates = [];       // 再生候補リスト
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
  mixCandidates = [];
  console.log(`upVoice 全削除完了 (${files.length}件)`);
}

/**
 * 再生候補を更新（古い順に最大10件）
 */
function updateMixCandidates() {
  const files = getUpVoiceFiles();
  mixCandidates = files.slice(0, MIX_CANDIDATE_COUNT);
  console.log(`再生候補更新: ${mixCandidates.length}件`);
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
 * 候補音声を FFmpeg amix でミックスして返却
 * 返却後、upVoice 内を全削除
 */
app.get("/mix", async (req, res) => {
  // ロック確認（同時実行防止）
  if (isMixing) {
    return res.status(429).json({ ok: false, error: "現在ミックス処理中です。しばらくお待ちください。" });
  }

  const files = getUpVoiceFiles();
  
  if (files.length === 0) {
    return res.status(404).json({ ok: false, error: "ミックスする音声がありません" });
  }

  // 古い順に最大10件取得
  const targetFiles = files.slice(0, MIX_CANDIDATE_COUNT);
  
  if (targetFiles.length === 1) {
    // ファイルが1つの場合はそのまま返却
    try {
      isMixing = true;
      res.setHeader("Content-Type", "audio/webm");
      res.setHeader("Content-Disposition", "attachment; filename=mixed.webm");
      
      const stream = fs.createReadStream(targetFiles[0].path);
      stream.pipe(res);
      
      stream.on("end", () => {
        clearAllUpVoiceFiles();
        isMixing = false;
      });
      
      stream.on("error", (err) => {
        console.error("ストリームエラー:", err);
        isMixing = false;
      });
    } catch (error) {
      console.error("単一ファイル返却エラー:", error);
      isMixing = false;
      res.status(500).json({ ok: false, error: "ファイル返却中にエラーが発生しました" });
    }
    return;
  }

  // 複数ファイルをミックス
  isMixing = true;

  try {
    // FFmpeg amix コマンド構築
    const inputArgs = [];
    targetFiles.forEach(f => {
      inputArgs.push("-i", f.path);
    });

    const filterComplex = `amix=inputs=${targetFiles.length}:duration=longest:dropout_transition=2`;

    const ffmpegArgs = [
      ...inputArgs,
      "-filter_complex", filterComplex,
      "-ac", "2",           // ステレオ
      "-ar", "44100",       // サンプルレート
      "-f", "webm",         // 出力フォーマット
      "-c:a", "libopus",    // コーデック
      "pipe:1"              // stdout に出力
    ];

    console.log(`FFmpeg amix 開始: ${targetFiles.length}件`);

    const ffmpeg = spawn("ffmpeg", ffmpegArgs);

    res.setHeader("Content-Type", "audio/webm");
    res.setHeader("Content-Disposition", "attachment; filename=mixed.webm");

    // FFmpeg stdout をレスポンスにパイプ
    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on("data", (data) => {
      // FFmpeg のログ出力（デバッグ用）
      // console.log(`FFmpeg: ${data}`);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        console.log("FFmpeg amix 完了");
        // ミックス成功後、全ファイル削除
        clearAllUpVoiceFiles();
      } else {
        console.error(`FFmpeg 終了コード: ${code}`);
      }
      isMixing = false;
    });

    ffmpeg.on("error", (err) => {
      console.error("FFmpeg 実行エラー:", err);
      isMixing = false;
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: "FFmpeg 実行中にエラーが発生しました" });
      }
    });

  } catch (error) {
    console.error("ミックス処理エラー:", error);
    isMixing = false;
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: "ミックス処理中にエラーが発生しました" });
    }
  }
});

/**
 * GET /status
 * デバッグ用：upVoice の状態を返す
 */
app.get("/status", (req, res) => {
  const files = getUpVoiceFiles();
  res.json({
    ok: true,
    totalFiles: files.length,
    candidateCount: mixCandidates.length,
    isMixing,
    files: files.map(f => f.name),
    candidates: mixCandidates.map(f => f.name)
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

// 25分おきに再生候補を更新
// テストの為２分に変更！
cron.schedule("*/2 * * * *", () => {
  console.log("=== 2分おきスキャン実行 ===");
  updateMixCandidates();
});

// 毎日6時に upVoice 内を全削除（保険）
cron.schedule("0 6 * * *", () => {
  console.log("=== 毎日6時の全削除実行 ===");
  clearAllUpVoiceFiles();
});

// ====== サーバー起動 ======
app.listen(PORT, () => {
  console.log(`🎙️ 録音サーバー起動: http://localhost:${PORT}`);
  console.log(`📁 upVoice ディレクトリ: ${UPVOICE_DIR}`);
  console.log(`📊 ファイル上限: ${MAX_FILES}件`);
  console.log(`🔀 ミックス対象: 最大${MIX_CANDIDATE_COUNT}件`);
  console.log("====テストの為２分おきに再生=======");
  
  // 起動時に候補を更新
  updateMixCandidates();
});
