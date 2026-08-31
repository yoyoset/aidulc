//! commands/timing.rs —— 跟读时间轴人工校准 (分段锚点)
//!
//! 背景与设计理由见 `store/timing_repo.rs` 头注释。这一层只做参数搬运, 不含判断逻辑。
//!
//! 性能约定: `timing_offsets_list` 由前端在**打开一本书时调一次**取回整本锚点 (通常 0 行),
//! 之后切章零 IO、每帧高亮零额外开销 —— 偏移是在章节加载时一次性平移进 `sentence.audio`
//! 的, 不是在播放循环里逐帧换算。

use crate::store;
use crate::store::timing_repo::{TimingAnchor, TimingRepo};
use tauri::State;

/// 一本成品的全部校准锚点 (打开书时取一次)
#[tauri::command]
pub fn timing_offsets_list(
    db: State<store::Db>,
    book_id: String,
) -> Result<Vec<TimingAnchor>, String> {
    TimingRepo::new(db.inner()).list_for_edition(&book_id)
}

/// 落一条锚点; 返回该章落定后的全部锚点 (免前端再拉一次)
#[tauri::command]
pub fn timing_offset_set(
    db: State<store::Db>,
    book_id: String,
    chapter_index: i64,
    from_sentence: i64,
    offset_ms: i64,
) -> Result<Vec<TimingAnchor>, String> {
    TimingRepo::new(db.inner()).set(&book_id, chapter_index, from_sentence, offset_ms)
}

/// 复位一章的校准
#[tauri::command]
pub fn timing_offset_reset(
    db: State<store::Db>,
    book_id: String,
    chapter_index: i64,
) -> Result<Vec<TimingAnchor>, String> {
    let repo = TimingRepo::new(db.inner());
    repo.reset_chapter(&book_id, chapter_index)?;
    repo.list_for_chapter(&book_id, chapter_index)
}
