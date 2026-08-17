//! commands/vocab_audio.rs —— 生词本「补全发音」后台任务的三个命令
//!
//! 实现在 application/vocab_audio_task.rs(含"为什么不进 jobs 队列"的说明)。
//! 这里只是薄壳: 取 State、算模型路径、转发。

use std::sync::Arc;
use tauri::State;

use crate::application::vocab_audio_task as task;
use crate::store;

/// 启动补发音。已经在跑就返回当前进度(幂等, 连点两下不会起两个)。
#[tauri::command]
pub fn vocab_audio_start(
    app: tauri::AppHandle,
    paths: State<'_, crate::DataPaths>,
    cfg: State<'_, crate::PrepConfig>,
    db: State<'_, store::Db>,
    vstate: State<'_, Arc<task::VocabAudioState>>,
    words: Vec<String>,
) -> Result<task::VocabAudioProgress, String> {
    let (_llm, tts_model, _spacy) = crate::application::model_service::resolve_paths(&db, "en");
    task::start(
        app,
        vstate.inner().clone(),
        cfg.prep_path.clone(),
        paths.data_dir.clone(),
        tts_model,
        words,
    )
}

/// 当前进度。前端进处理中页时先拉一次(事件只在跑动时来, 刚进页面拿不到)。
#[tauri::command]
pub fn vocab_audio_status(
    vstate: State<'_, Arc<task::VocabAudioState>>,
) -> Result<task::VocabAudioProgress, String> {
    Ok(vstate.progress.lock().unwrap().clone())
}

/// 取消。只置标志, 工作线程处理完当前这个词就收尾(不硬杀, 避免半个 wav 落盘)。
#[tauri::command]
pub fn vocab_audio_cancel(vstate: State<'_, Arc<task::VocabAudioState>>) -> Result<(), String> {
    *vstate.cancel.lock().unwrap() = true;
    Ok(())
}
