/**
 * views/reader/highlight_tags_store.js —— 摘录自定义标签 (2026-09-05)
 *
 * 取代 v36 上线当天就被用户否掉的固定三分类("默认/待复习/生词相关")。用户反馈
 * 两点: 分类应该自己定义(比如"好句子"/"谚语"/"情感强烈"), 而且完全不知道去
 * 哪加标签——之前那版只在摘录面板每一行的小下拉里选, 没有一个明确的"管理标签"
 * 入口。这个模块单独拆出来(而不是塞进 highlights.js), 是因为"标签的增删改"和
 * "摘录本身的增删改"是两个不同粒度的操作对象, 塞一起会让 highlights.js 单个文件
 * 同时干两件事、逼近文件行数上限——镜像项目里 settings_view.js 按 tab 拆分的先例。
 */
(function (global) {
  'use strict';

  class HighlightTagsStore {
    constructor(userId) {
      this.userId = userId;
      this.tags = []; // [{id, user_id, label, created_at}]
    }

    async load() {
      const res = await AiduBridge.highlightTags.list(this.userId);
      this.tags = (res.ok && Array.isArray(res.data)) ? res.data : [];
      return this.tags;
    }

    /** 标签 id → 展示文案。空 id / 找不到对应标签(比如标签已被删)一律"未分类"。 */
    labelFor(tagId) {
      if (!tagId) return '未分类';
      const t = this.tags.find((x) => x.id === tagId);
      return t ? t.label : '未分类';
    }

    async create(label) {
      const trimmed = (label || '').trim();
      if (!trimmed) return { ok: false, error: '标签名不能为空' };
      const tag = {
        id: 'tag-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        user_id: this.userId,
        label: trimmed,
        created_at: Date.now(),
      };
      const res = await AiduBridge.highlightTags.create(tag);
      if (res.ok) this.tags.push(tag);
      return res;
    }

    async rename(id, label) {
      const trimmed = (label || '').trim();
      if (!trimmed) return { ok: false, error: '标签名不能为空' };
      const res = await AiduBridge.highlightTags.rename(this.userId, id, trimmed);
      if (res.ok) {
        const t = this.tags.find((x) => x.id === id);
        if (t) t.label = trimmed;
      }
      return res;
    }

    async remove(id) {
      const res = await AiduBridge.highlightTags.remove(this.userId, id);
      if (res.ok) this.tags = this.tags.filter((x) => x.id !== id);
      return res;
    }

    /** 标签管理小面板(挂在摘录面板里, 折叠展开)。onChange 在任何增删改成功后触发,
     *  调用方(ReaderHighlights)借此重渲染依赖标签列表的地方(每行的分类下拉/
     *  筛选下拉——那些标签名字/存在与否可能已经变了)。 */
    renderManagerPanel(onChange) {
      const wrap = document.createElement('div');
      wrap.className = 'hltag-manager';

      const list = document.createElement('div');
      list.className = 'hltag-manager-list';

      const renderList = () => {
        list.innerHTML = '';
        if (!this.tags.length) {
          list.appendChild(Object.assign(document.createElement('div'), {
            className: 'hltag-manager-empty',
            textContent: '还没有标签, 在下面输入名字新建一个(比如"好句子"/"谚语")。',
          }));
        }
        this.tags.forEach((t) => {
          const row = document.createElement('div');
          row.className = 'hltag-manager-row';
          const nameInput = document.createElement('input');
          nameInput.type = 'text';
          nameInput.className = 'hltag-name-input';
          nameInput.value = t.label;
          nameInput.onchange = () => {
            this.rename(t.id, nameInput.value).then((res) => {
              if (!res.ok) {
                AiduToast.show('改标签名失败: ' + res.error, 'error');
                nameInput.value = t.label;
                return;
              }
              onChange && onChange();
            });
          };
          const del = document.createElement('button');
          del.className = 'btn-small btn-danger';
          del.textContent = '删除';
          del.title = '删除这个标签后, 打过这个标签的摘录会变回"未分类"(摘录本身不会被删)';
          del.onclick = () => {
            this.remove(t.id).then((res) => {
              if (!res.ok) { AiduToast.show('删标签失败: ' + res.error, 'error'); return; }
              renderList();
              onChange && onChange();
            });
          };
          row.append(nameInput, del);
          list.appendChild(row);
        });
      };
      renderList();

      const addRow = document.createElement('div');
      addRow.className = 'hltag-manager-add';
      const addInput = document.createElement('input');
      addInput.type = 'text';
      addInput.className = 'hltag-name-input';
      addInput.placeholder = '新标签名, 回车新建…';
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-small btn-primary';
      addBtn.textContent = '新建';
      const doCreate = () => {
        const label = addInput.value;
        this.create(label).then((res) => {
          if (!res.ok) { AiduToast.show('新建标签失败: ' + res.error, 'error'); return; }
          addInput.value = '';
          renderList();
          onChange && onChange();
        });
      };
      addBtn.onclick = doCreate;
      addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doCreate(); });
      addRow.append(addInput, addBtn);

      wrap.append(list, addRow);
      return wrap;
    }
  }

  global.HighlightTagsStore = HighlightTagsStore;
})(window);
