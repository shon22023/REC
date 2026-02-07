


// ======= session.htmlの読み込み =======

// 再試行ボタンを追加

// aaaa

const startSessionButton = document.getElementById('startSessionButton');
const EXITButton = document.getElementById('EXITButton');
const CANCELButton = document.getElementById('CANCELButton');
const tryButton = document.getElementById('tryButton');
const ENDsessionButton = document.getElementById('ENDsessionButton');
const backButton = document.getElementById('backButton');

import { checkNetWork } from "../isOnline/isOnline.js";
import { saveChunk, getAllChunks, deleteChunk, migrateFromLocalStorage } from "./audioStorage.js";


if (backButton) {
    backButton.addEventListener('click', function() {
        const exitModal = document.getElementById("exitModal");
        exitModal.style.display = "block"; //モーダルを表示する
      });
  }


if (EXITButton) {
  EXITButton.addEventListener('click', function() {
    cleanup(); //初期化する関数。
    window.location.href = "../UI/index.html"; // index.htmlにいかん
  });
}

if (CANCELButton) {
  CANCELButton.addEventListener('click', function() {
    const exitModal = document.getElementById("exitModal");
    exitModal.style.display = "none"; //モーダルを非表示にする
  });
}

if (ENDsessionButton) {
  ENDsessionButton.addEventListener('click', async function() {
    const exitModal = document.getElementById("exitModal");
    exitModal.style.display = "block"; //モーダルを表示する
  });
}

// 再試行ボタンのイベントリスナー
if (tryButton) {
  tryButton.addEventListener('click', async function() {
    const tryNetModal = document.getElementById('tryNetModal');

    // 接続状態を確認
    if (await checkNetWork() === true) {
        console.log('接続が復旧しました。保留中のデータを送信します');
        tryNetModal.style.display = "none"; // モーダルを閉じる
        
        // 接続が復旧したので、保留中のチャンクを送信
        await sendPendingChunks();
        
        // uploadDisabledフラグをリセット（接続が復旧した可能性があるため）
        if (uploadDisabled) {
            uploadDisabled = false;
            console.log('アップロード機能を再有効化しました');
        }
    } else {
        console.log('まだオフラインです。接続を確認してください');
        // まだオフラインの場合はモーダルを表示し続ける
        // （モーダルは既に表示されているので何もしない）
    }
  });
}


// 状態管理
const RecordingState = {
    IDLE: 'idle',
    RECORDING: 'recording',
    STOPPING: 'stopping'
};

let state = RecordingState.IDLE;
let chunk = [];
let timer = null;
let mediaRecorder = null;
let audioNodes = null;
let audioStream = null;
let restartTimeoutId = null;
let isUploading = false;
let uploadDisabled = false;

// AudioContextを再利用（メモリリーク対策）
let sharedAudioContext = null;

// ミックス音声ループ再生用
let currentMixAudio = null;  // 現在再生中のミックス音声
let mixLoopTimer = null;      // 30分ループタイマー
let mixRetryTimeoutId = null; // ミックス再試行タイマー
const MIX_LOOP_DURATION = 30 * 60 * 1000; // 30分（ミリ秒）

// 設定（重さ・増殖対策）
const TIMESLICE_MS = 5000; // 1秒だとイベント頻度が高く重くなりやすい
const ENABLE_MONITORING_TO_SPEAKER = false; // マイク音をスピーカーに流す（必要な時だけtrue）

// ページ読み込み時に音声許可を取得
document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log('音声許可をリクエストしています...');
        audioStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });
        await checkNetWork(); //ネットワークをチェックする
        
        // LocalStorageからIndexedDBへの移行（初回のみ）
        try {
            await migrateFromLocalStorage(LOCAL_STORAGE_KEY);
        } catch (migrateError) {
            console.warn('LocalStorage移行エラー（続行）:', migrateError);
        }
        
        console.log('========= 音声許可が取得されました =================');
    } catch (error) {
        console.error('音声許可が拒否されました:', error);
        alert('音声録音の許可が必要です。index.htmlに戻ります。');
        window.location.href = "../UI/index.html";
        return;
    }
});

// ローカルストレージのキー
const LOCAL_STORAGE_KEY = 'pending_audio_chunks';

// 音声アップロード先（Render）
// 例: window.AUDIO_SERVER_BASE = "http://localhost:3000"
// 未設定ならアップロードしない（404/再送ループで重くなるのを防ぐ）
const AUDIO_SERVER_BASE =
    (typeof window.AUDIO_SERVER_BASE === "string" && window.AUDIO_SERVER_BASE.trim())
        ? window.AUDIO_SERVER_BASE.trim().replace(/\/+$/, "")
        : ((location.hostname === "localhost" || location.hostname === "127.0.0.1")
            ? "https://rec-glm1.onrender.com" // サーバーのURL
            : null);
const UPLOAD_ENABLED = Boolean(AUDIO_SERVER_BASE);

function isNetworkFetchError(error) { //ネットワークエラーかどうかを判断する関数
    return error instanceof TypeError
        && typeof error.message === "string"
        && /Failed to fetch|NetworkError/i.test(error.message);
}

function disableUploadWithReason(reason) { //音声サーバーへの接続に失敗した場合の処理
    if (uploadDisabled) return;
    uploadDisabled = true;
    console.warn(`音声サーバーへの接続に失敗しました: ${reason}`);
    console.warn("音声サーバーが起動していない可能性があります。必要ならサーバーを起動してください。");
}

function clearRestartTimeout() { //録音を再開するためのタイムアウトをクリアする関数
    if (restartTimeoutId) {
        clearTimeout(restartTimeoutId);
        restartTimeoutId = null;
    }
}

function scheduleNextRecording() { //録音を再開するためのタイムアウトを設定する関数
    clearRestartTimeout();
    restartTimeoutId = setTimeout(() => {
        restartTimeoutId = null;
        if (state === RecordingState.IDLE) {
            // click()だと他のclickリスナーも走りやすいので、録音開始を直接呼ぶ
            startRecording();
        }
    }, 5 * 60 * 1000); // 5分 = 300000ms
}

async function startRecording() {
    // 既に録音中の場合は何もしない
    if (state !== RecordingState.IDLE) {
        console.log('既に録音中です');
        return;
    }

    // 音声ストリームが取得されていない場合はエラー
    if (!audioStream) {
        console.error('音声ストリームが取得されていません');
        alert('音声録音の許可が必要です。ページを再読み込みしてください。');
        return;
    }

    try {
        console.log('セッションを開始しました');
        state = RecordingState.RECORDING;

        // オーバーレイを非表示にする
        const overlay = document.getElementById('sessionOverlay');
        if (overlay) overlay.classList.add('hidden');

        audioNodes = await GainNode(audioStream);

        // 加工後の音声を録音するためにMediaStreamDestinationを使用
        const processedStream = audioNodes.destination.stream;

        // MediaRecorderの初期化（加工後の音声を録音）
        mediaRecorder = new MediaRecorder(processedStream, {
            mimeType: "audio/webm" // mp3は非対応のため、webmを使用
        });

        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
                // 毎回のconsole.logは重くなりやすいので抑制
                chunk.push(e.data);
            }
        };

        mediaRecorder.onstop = () => {
            console.log('MediaRecorder stopped');
        };

        mediaRecorder.onerror = (e) => {
            console.error('MediaRecorder error:', e);
            cleanup({ stopStream: false });
            state = RecordingState.IDLE;
        };

        mediaRecorder.start(TIMESLICE_MS);

        timer = setTimeout(() => {
            console.log('5分経過しました');
            stopREC();
        }, 5 * 60 * 1000); // 5分 = 300000ms
    } catch (error) {
        console.error('録音開始エラー:', error);
        state = RecordingState.IDLE;
        cleanup({ stopStream: false });
    }
}


if (startSessionButton) {
  startSessionButton.addEventListener('click', async () => {
    await startRecording();
    const backgroundImage = document.getElementById('backgroundImage');
    backgroundImage.style.display = "none"; //背景かぞうを非表示にする
    console.log("背景画像を非表示にしました/sessionを開始しました！");

  });
}


// startREC関数は不要になりました（DOMContentLoaded時に許可を取得）

async function stopREC() {
    if (state !== RecordingState.RECORDING) {
        console.log('録音中ではありません');
        return;
    }
    
    state = RecordingState.STOPPING;
    
    if (timer) {
        clearTimeout(timer); // タイマーを停止
        timer = null;
    }
    
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop(); // 録音を停止
    }
    
    // サーバーに送信
    const chunkToSend = chunk.slice();
    chunk.length = 0;
    await serverSend(chunkToSend);
    
    // リソースのクリーンアップ（ストリームは維持して次回に備える）
    cleanup({ stopStream: false });
    
    state = RecordingState.IDLE;
    
    // ミックス音声を取得して再生（少し待ってから取得）
    setTimeout(async () => {
        await fetchAndPlayMix(); //==================ミックス音声を取得して再生する関数==================
    }, 1000);
    
    // 次回録音の予約（増殖防止）
    scheduleNextRecording();
}

// リソースのクリーンアップ関数
function cleanup({ stopStream } = { stopStream: true }) {
    // AudioStreamの停止（退出時のみ）
    if (stopStream && audioStream) {
        audioStream.getTracks().forEach(track => track.stop());
        audioStream = null;
    }
    
    // Audioノードの切断（AudioContextは再利用するためcloseしない）
    if (audioNodes) {
        try {
            // 各ノードを切断してメモリ解放
            if (audioNodes.source) {
                audioNodes.source.disconnect();
            }
            if (audioNodes.gain) {
                audioNodes.gain.disconnect();
            }
            if (audioNodes.destination) {
                audioNodes.destination.disconnect();
            }
            console.log('AudioNodeを切断しました（AudioContextは再利用）');
        } catch (e) {
            console.warn('AudioNode切断エラー（無視可）:', e);
        }
        audioNodes = null;
    }
    
    // 完全退出時のみAudioContextをclose
    if (stopStream && sharedAudioContext) {
        sharedAudioContext.close();
        sharedAudioContext = null;
        console.log('AudioContextを閉じました');
    }
    
    // MediaRecorderのクリーンアップ
    if (mediaRecorder) {
        if (mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        mediaRecorder = null;
    }
    
    // タイマーのクリア
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    
    clearRestartTimeout();
    
    // ミックス音声のクリーンアップ
    cleanupMixAudio();
    console.log("============= クリーンアップが完了しました！ =================");

    // chunkは呼び出し側で管理（必要なら明示的に空にする）
}

async function GainNode(stream) {
    // AudioContextを再利用（パフォーマンス改善・メモリリーク対策）
    if (!sharedAudioContext || sharedAudioContext.state === 'closed') {
        sharedAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('AudioContextを新規作成しました');
    } else {
        console.log('既存のAudioContextを再利用します');
    }
    
    const ctx = sharedAudioContext;
    
    // AudioContextがsuspendedの場合はresumeする
    if (ctx.state === 'suspended') {
        await ctx.resume();
    }
    
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain(); // gainの作成（音量調整）
    gain.gain.value = 0.18; // ゲインを少し上げる（作業音を鮮明に）

    source.connect(gain); // sourceをgainに接続
    
    // EQNode は同期関数（AudioNodeを返す）
    const eqOutput = EQNode(ctx, gain); // EQNodeをgainに接続
    
    // リバーブを追加
    const reverbOutput = addReverb(ctx, eqOutput);
    
    // 録音用のdestinationを作成（加工後の音声をキャプチャ）
    const destination = ctx.createMediaStreamDestination();
    reverbOutput.connect(destination); // 録音用に接続
    
    // モニタリング用（重い/ハウリングの元になりやすいのでデフォルトOFF）
    if (ENABLE_MONITORING_TO_SPEAKER) {
        reverbOutput.connect(ctx.destination);
    }
    
    return { source, gain, ctx, destination };
}

function EQNode(ctx, input) {
    // 1. 底域カット (300Hz)
    const HImid = ctx.createBiquadFilter();
    HImid.type = "peaking";
    HImid.frequency.value = 300;
    HImid.Q.value = 0.6;
    HImid.gain.value = -25; // より強くカット

    // 2. 低中域カット (500Hz: 声の低域を削る)
    const lowMid = ctx.createBiquadFilter();
    lowMid.type = "peaking";
    lowMid.frequency.value = 500;
    lowMid.Q.value = 0.8;
    lowMid.gain.value = -15; // 声の低域をカット

    // 3. 中域カット (1000Hz: 声の芯を削る)
    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 1.2;
    mid.gain.value = -8; // カットを緩和（作業音を鮮明に）

    // 4. 中高域カット (1700Hz: 声の中域を削る)
    const midHigh = ctx.createBiquadFilter();
    midHigh.type = "peaking";
    midHigh.frequency.value = 1700;
    midHigh.Q.value = 1.0;
    midHigh.gain.value = -18; // カットを緩和（作業音を鮮明に）

    // 5. 高中域カット (3000Hz: 滑舌・明瞭度を削る)
    const highMid = ctx.createBiquadFilter();
    highMid.type = "peaking";
    highMid.frequency.value = 3000; 
    highMid.Q.value = 0.7;
    highMid.gain.value = -18; // カットを緩和（作業音の明瞭度を上げる）

    // 6. 高域カット 
    const high = ctx.createBiquadFilter();
    high.type = "highpass";
    high.frequency.value = 1200;
    high.Q.value = 0.6;
    high.gain.value = -8; // 高域をカット

    // フィルターを接続
    input.connect(HImid);
    HImid.connect(lowMid);
    lowMid.connect(mid);
    mid.connect(midHigh);
    midHigh.connect(highMid);
    highMid.connect(high);
    
    return high; // 最後のフィルターを返す
}

// 軽量なリバーブエフェクトを追加
function addReverb(ctx, input) {
    // メイン出力用のGainNode（原音）
    const dryGain = ctx.createGain();
    dryGain.gain.value = 0.80; // 原音を88%
    
    // リバーブ用のGainNode
    const wetGain = ctx.createGain();
    wetGain.gain.value = 0.12; // リバーブを12%（控えめ）
    
    // 原音をそのまま出力
    input.connect(dryGain);
    
    // リバーブ処理（複数のDelayNodeでエコー効果）
    const delay1 = ctx.createDelay();
    delay1.delayTime.value = 0.018; // 25ms
    
    const delay2 = ctx.createDelay();
    delay2.delayTime.value = 0.038; // 45ms
    
    const delay3 = ctx.createDelay();
    delay3.delayTime.value = 0.058; // 65ms
    
    // 各ディレイのゲイン（徐々に減衰）
    const delayGain1 = ctx.createGain();
    delayGain1.gain.value = 0.10;
    
    const delayGain2 = ctx.createGain();
    delayGain2.gain.value = 0.05;
    
    const delayGain3 = ctx.createGain();
    delayGain3.gain.value = 0.02;
    
    // リバーブチェーン（並列接続）
    input.connect(delay1);
    input.connect(delay2);
    input.connect(delay3);
    
    delay1.connect(delayGain1);
    delay2.connect(delayGain2);
    delay3.connect(delayGain3);
    
    // リバーブに軽いローパスフィルターを適用（自然な響き、高域をカット）
    const reverbFilter = ctx.createBiquadFilter();
    reverbFilter.type = "lowpass";
    reverbFilter.frequency.value = 2500; // 高域をカット
    reverbFilter.Q.value = 0.1;
    
    delayGain1.connect(reverbFilter);
    delayGain2.connect(reverbFilter);
    delayGain3.connect(reverbFilter);
    
    reverbFilter.connect(wetGain);
    
    // 原音とリバーブをミックス
    const outputGain = ctx.createGain();
    dryGain.connect(outputGain);
    wetGain.connect(outputGain);
    
    return outputGain;
}

   // まず、接続確認
 function isOnline() {
    const tryNetModal = document.getElementById('tryNetModal');

    window.addEventListener('online', async () => {
       if(await checkNetWork() === true) {
        console.log('オンラインです！');
        await sendPendingChunks();
       } 

       if(!(await checkNetWork())) { // 繋がらない。あるいは不安定な場合

        setTimeout(async () => {
            if(await checkNetWork() === true) {
                // オンライン復帰時は保留分のみ送信（chunkは録音中に増えるため送らない）
                console.log('=========オンラインです！！============');
                 console.log("======== chunkをサーバーに送信します！ ===============");
                 await sendPendingChunks();
                  return;
         } else if(await checkNetWork() === false) {
             console.warn('タイムアウトしまし！');
              if (tryNetModal) tryNetModal.style.display = "block";
               return;
         }
         }, 10000); //１0秒後に判定！
       }
      });
   window.addEventListener('offline', () => {
    console.log("オフラインです！");
     if (tryNetModal) tryNetModal.style.display = "block"; // 再接続モーダルを表示

   });

 }


async function serverSend(chunkData, retryCount = 0) {
  const MAX_RETRY = 3;
  const RETRY_DELAY = 2000; // 2秒
  
  try {
     if (!chunkData || chunkData.length === 0) return;

     if (!UPLOAD_ENABLED || uploadDisabled) {
        // 送信先が未設定/無効化中ならローカル保存
        await saveToLocalStorage(chunkData);
        return;
     }

     // 多重送信防止（online/loadから同時に走るのを防ぐ）
     if (isUploading) return;
     isUploading = true;

     const FD = new FormData();
     const blob = new Blob(chunkData, { type: 'audio/webm' });
     const filename = `chunk_${Date.now()}.webm`;
     FD.append("audio" , blob , filename);

     const response = await fetch(`${AUDIO_SERVER_BASE}/upload`, {
      method: "POST",
      body: FD,
     });
     
      if(!response.ok) {
        // 4xxは基本的にリトライしても治らないので即停止してローカル保存
        if (response.status >= 400 && response.status < 500) {
            console.error(`✗ サーバー送信エラー(4xx): ${response.status}`);
            if (response.status === 404) {
                // /upload が無い状態。以後の送信を止めて重さ/ループを防ぐ
                uploadDisabled = true;
            }
            await saveToLocalStorage(chunkData);
            return;
        }
        throw new Error(`サーバー送信エラー: ${response.status}`);
      }
      
      const chunkSizeMB = (blob.size / 1024 / 1024).toFixed(2);
      console.log(`✓ サーバー送信成功 (${chunkSizeMB}MB)`);
      cleanChunk();
      
      // ローカルストレージに保存されていたデータがあれば送信を試みる
      queueMicrotask(() => { sendPendingChunks(); });
      
  } catch(error) {
    console.error('送信エラーが発生しました！', error);

    if (isNetworkFetchError(error)) {
        disableUploadWithReason("ネットワーク/接続エラー");
        await saveToLocalStorage(chunkData);
        return;
    }

    // リトライ処理
    if (retryCount < MAX_RETRY) {
        console.log(`リトライします... (${retryCount + 1}/${MAX_RETRY})`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        return serverSend(chunkData, retryCount + 1);
    } else {
        // リトライ上限に達したらローカルに保存
        console.log('リトライ上限に達しました。ローカルに保存します');
        await saveToLocalStorage(chunkData);
    }
  } finally {
    isUploading = false;
  }
     
}

// IndexedDBに保存（旧: saveToLocalStorage）
async function saveToLocalStorage(chunkData) {
    try {
        const blob = new Blob(chunkData, { type: 'audio/webm' });
        const filename = `chunk_${Date.now()}.webm`;
        const sizeMB = (blob.size / 1024 / 1024).toFixed(2);
        
        // IndexedDBに保存（LocalStorageより大容量対応、パフォーマンス改善）
        await saveChunk(blob, filename);
        console.log(`✓ IndexedDBに保存しました: ${filename} (${sizeMB}MB)`);
    } catch (error) {
        console.error('✗ IndexedDBへの保存に失敗しました', error);
        // フォールバック: 失敗時はLocalStorageに保存（互換性維持）
        try {
            const blob = new Blob(chunkData, { type: 'audio/webm' });
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64data = reader.result;
                const savedChunks = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || '[]');
                savedChunks.push({
                    data: base64data,
                    timestamp: Date.now(),
                    filename: `chunk_${Date.now()}.webm`
                });
                localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(savedChunks));
                console.log('⚠ フォールバック: LocalStorageに保存しました');
            };
            reader.readAsDataURL(blob);
        } catch (fallbackError) {
            console.error('✗ LocalStorageへのフォールバックも失敗しました', fallbackError);
        }
    }
}

// IndexedDBから保留中のチャンクを送信（旧: ローカルストレージから）
async function sendPendingChunks() {
    try {
        if (!UPLOAD_ENABLED || uploadDisabled) return;
        if (isUploading) return;

        // IndexedDBから全チャンクを取得
        const savedChunks = await getAllChunks();
        
        if (savedChunks.length === 0) {
            return;
        }
        
        if(!(await checkNetWork())) {
            console.log("⚠ オンラインではありません！10秒後に再試行します");
            setTimeout(sendPendingChunks, 10000); // 10秒後に再試行
            return;
        }
        
        const totalSizeMB = (savedChunks.reduce((sum, chunk) => sum + chunk.blob.size, 0) / 1024 / 1024).toFixed(2);
        console.log(`📤 保留中のチャンクを送信します: ${savedChunks.length}件 (合計 ${totalSizeMB}MB)`);
        
        for (const chunk of savedChunks) {
            try {
                if (isUploading) return;
                isUploading = true;

                const FD = new FormData();
                FD.append("audio", chunk.blob, chunk.filename);
                
                const uploadResponse = await fetch(`${AUDIO_SERVER_BASE}/upload`, {
                    method: "POST",
                    body: FD,
                });
                
                if (uploadResponse.ok) {
                    const chunkSizeMB = (chunk.blob.size / 1024 / 1024).toFixed(2);
                    console.log(`✓ 保留チャンク送信成功: ${chunk.filename} (${chunkSizeMB}MB)`);
                    // 送信成功したらIndexedDBから削除
                    await deleteChunk(chunk.id);
                } else {
                    if (uploadResponse.status >= 400 && uploadResponse.status < 500) {
                        console.error(`✗ 保留チャンク送信エラー(4xx): ${uploadResponse.status}`);
                        if (uploadResponse.status === 404) uploadDisabled = true;
                        break;
                    }
                    console.log(`⚠ 保留チャンク送信失敗: ${chunk.filename}`);
                    break; // 1つ失敗したら残りは次回に
                }
            } catch (error) {
                console.error('保留チャンク送信エラー:', error);
                if (isNetworkFetchError(error)) {
                    disableUploadWithReason("ネットワーク/接続エラー");
                }
                break;
            } finally {
                isUploading = false;
            }
        }
    } catch (error) {
        console.error('保留チャンク処理エラー:', error);
    }
}

// chunkを消去する関数
async function cleanChunk() {
  chunk.length = 0; // 配列を空にする正しい方法
  if(chunk.length === 0) {
     console.log("chunkを消去できました！！", chunk.length);
     // 再開予約はstopREC側で行う（増殖防止）
  } else {
    console.log("chunkを消去できませんでした！！", chunk.length);
  }
}

// ミックス音声とタイマーをクリーンアップする関数
function cleanupMixAudio() {
    // タイマーをクリア
    if (mixLoopTimer) {
        clearTimeout(mixLoopTimer);
        mixLoopTimer = null;
        console.log('ミックスループタイマーをクリアしました');
    }
    if (mixRetryTimeoutId) {
        clearTimeout(mixRetryTimeoutId);
        mixRetryTimeoutId = null;
    }
    
    // 現在再生中のミックス音声を停止・解放
    if (currentMixAudio) {
        try {
            currentMixAudio.pause();
            currentMixAudio.currentTime = 0;
            
            // ObjectURLを解放
            if (currentMixAudio._audioUrl) {
                URL.revokeObjectURL(currentMixAudio._audioUrl);
                console.log('ミックス音声のURLを解放しました');
            }
        } catch (e) {
            console.error('ミックス音声のクリーンアップエラー:', e);
        }
        currentMixAudio = null;
        console.log('ミックス音声を停止・削除しました');
    }
}

// サーバーからミックス音声を取得して30分ループ再生
let isFetchingMix = false;

function scheduleMixRetry(delayMs) {
    if (mixRetryTimeoutId) {
        clearTimeout(mixRetryTimeoutId);
    }
    mixRetryTimeoutId = setTimeout(() => {
        mixRetryTimeoutId = null;
        fetchAndPlayMix();
    }, delayMs);
}

async function fetchAndPlayMix() {          //==================ミックス音声を取得して30分ループ再生する関数==================
    if (!UPLOAD_ENABLED || uploadDisabled) {
        console.log('サーバーが設定されていないか、無効化されています');
        return null;
    }

    if (isFetchingMix) {
        console.log('既にミックス取得中です');
        return null;
    }

    isFetchingMix = true;

    try {
        // 既存のミックス音声があれば停止してクリーンアップ
        cleanupMixAudio();

        console.log('ミックス音声を取得中...');
        const response = await fetch(`${AUDIO_SERVER_BASE}/mix`);
        
        if (!response.ok) {
            if (response.status === 404) {
                console.log('ミックスする音声がありません。30秒後に再試行します');
                // 30秒後に再試行
                scheduleMixRetry(30000);
                return null;
            }
            if (response.status === 429) {
                console.log('サーバーでミックス処理中です。20秒後に再試行します');
                // 20秒後に再試行
                scheduleMixRetry(20000);
                return null;
            }
            throw new Error(`ミックス取得エラー: ${response.status}`);
        }

        const audioBlob = await response.blob();
        const sizeMB = (audioBlob.size / 1024 / 1024).toFixed(2);
        console.log(`✓ ミックス音声を取得しました: ${sizeMB}MB (${audioBlob.type})`);
        
        // Blobサイズチェック: 空のBlobまたは極端に小さいBlobは再生しない
        if (audioBlob.size === 0) {
            console.warn('⚠ ミックス音声のサイズが0バイトです。サーバーが空のレスポンスを返しました。30秒後に再試行します');
            scheduleMixRetry(30000);
            return null;
        }
        
        // 1KB未満のBlobも異常とみなす（正常な音声ファイルは通常もっと大きい）
        if (audioBlob.size < 1024) {
            console.warn(`⚠ ミックス音声のサイズが異常に小さいです: ${(audioBlob.size / 1024).toFixed(2)}KB。30秒後に再試行します`);
            scheduleMixRetry(30000);
            return null;
        }
        
        const audioUrl = URL.createObjectURL(audioBlob);
        
        const audio = new Audio(audioUrl);
        audio.loop = true; // ループ再生を有効化
        
        // グローバル変数に保存
        currentMixAudio = audio;
        currentMixAudio._audioUrl = audioUrl; // URLも保存（後でクリーンアップ用）

        audio.onerror = (e) => {
            console.error('✗ ミックス音声の再生エラー:', e);
            const errorCode = audio.error?.code;
            const errorMessage = audio.error?.message || '不明なエラー';
            const errorTypes = {
                1: 'MEDIA_ERR_ABORTED (再生が中断されました)',
                2: 'MEDIA_ERR_NETWORK (ネットワークエラー)',
                3: 'MEDIA_ERR_DECODE (デコードエラー)',
                4: 'MEDIA_ERR_SRC_NOT_SUPPORTED (形式未対応)'
            };
            console.error(`エラーコード: ${errorCode} - ${errorTypes[errorCode] || errorMessage}`);
            console.error(`Blob情報: サイズ=${(audioBlob.size / 1024).toFixed(2)}KB, タイプ=${audioBlob.type}`);
            cleanupMixAudio();
            // エラー時は30秒後に再試行
            scheduleMixRetry(30000);
        };

        await audio.play();
        console.log(`✓ ミックス音声を30分間ループ再生開始 (サイズ: ${sizeMB}MB, 形式: ${audioBlob.type})`);
        
        // 30分タイマーを設定
        mixLoopTimer = setTimeout(() => {
            console.log('30分経過しました。ミックス音声を削除して新しい音声を取得します');
            cleanupMixAudio();
            
            // 1秒後に再度/mixを取得
            scheduleMixRetry(1000);
        }, MIX_LOOP_DURATION);
        
        return audio;
    } catch (error) {
        console.error('ミックス音声取得エラー:', error);
        if (isNetworkFetchError(error)) {
            disableUploadWithReason("ネットワーク/接続エラー");
        }
        // エラー時は30秒後に再試行
        if (!uploadDisabled) {
            scheduleMixRetry(30000);
        }
        return null;
    } finally {
        isFetchingMix = false;
    }
}

// ミックス音声を取得してBlobとして返す（再生せずにダウンロードしたい場合用）
async function fetchMixBlob() {
    if (!UPLOAD_ENABLED || uploadDisabled) {
        console.log('サーバーが設定されていないか、無効化されています');
        return null;
    }

    try {
        const response = await fetch(`${AUDIO_SERVER_BASE}/mix`);
        
        if (!response.ok) {
            if (response.status === 404) {
                console.log('ミックスする音声がありません');
                return null;
            }
            throw new Error(`ミックス取得エラー: ${response.status}`);
        }

        return await response.blob();
    } catch (error) {
        console.error('ミックス音声取得エラー:', error);
        if (isNetworkFetchError(error)) {
            disableUploadWithReason("ネットワーク/接続エラー");
        }
        return null;
    }
}

async function startRECcount() {
  // 互換のため残すが、内部は単一予約に寄せる
  scheduleNextRecording();
}

// ページ読み込み時に保留中のチャンクを送信
window.addEventListener('load', () => {
    sendPendingChunks();
});

window.addEventListener("beforeunload", () => {
    cleanup({ stopStream: true });
});

document.addEventListener('DOMContentLoaded', () => {
    // ネットワーク監視（オフライン通知など）
    
    isOnline();
});

// 音量調整用のエクスポート関数
export function getMixAudio() {
    return currentMixAudio;
}
