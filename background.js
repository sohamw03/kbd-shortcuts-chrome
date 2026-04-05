// Handles keyboard commands for tab selection, movement, pinning, duplication, and grouping.
const COMMANDS = {
  SELECT_LEFT: 'select-tab-left',
  SELECT_RIGHT: 'select-tab-right',
  MOVE_LEFT: 'move-tab-left',
  MOVE_RIGHT: 'move-tab-right',
  TOGGLE_PIN: 'toggle-pin-tab',
  DUPLICATE: 'duplicate-tab',
  ADD_SELECTION_LEFT: 'add-selection-left',
  ADD_SELECTION_RIGHT: 'add-selection-right',
  GROUP_SELECTED: 'group-selected-tabs',
  TOGGLE_GROUP_COLLAPSED: 'toggle-group-collapsed'
};
const TAB_GROUP_ID_NONE = -1;

async function getTabContext() {
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab) return null;

  const tabs = await chrome.tabs.query({ windowId: activeTab.windowId });
  tabs.sort((a, b) => a.index - b.index);
  return { activeTab, tabs, windowId: activeTab.windowId };
}

async function getActiveTab() {
  return (await getTabContext())?.activeTab ?? null;
}

async function restoreHighlightedTabs(windowId, tabIds, activeTabId) {
  const currentTabs = await chrome.tabs.query({ windowId });
  const selectedTabs = currentTabs.filter((tab) => tabIds.includes(tab.id));
  if (selectedTabs.length === 0) return;

  const indices = selectedTabs.map((tab) => tab.index).sort((a, b) => a - b);
  const activeTab = selectedTabs.find((tab) => tab.id === activeTabId);
  const selection = activeTab
    ? [activeTab.index, ...indices.filter((index) => index !== activeTab.index)]
    : indices;

  await chrome.tabs.highlight({
    windowId,
    tabs: selection
  });
}

async function restoreTabOrder(windowId, orderedTabIds) {
  const currentTabs = await chrome.tabs.query({ windowId });
  const selectedTabs = currentTabs.filter((tab) => orderedTabIds.includes(tab.id));
  if (selectedTabs.length <= 1) return;

  const targetIndices = selectedTabs.map((tab) => tab.index).sort((a, b) => a - b);

  for (let i = 0; i < orderedTabIds.length; i += 1) {
    const refreshedTabs = await chrome.tabs.query({ windowId });
    const tab = refreshedTabs.find((currentTab) => currentTab.id === orderedTabIds[i]);
    if (!tab) continue;
    if (tab.index !== targetIndices[i]) {
      await moveTab(tab.id, targetIndices[i]);
    }
  }
}

async function moveTab(tabId, index, retries = 2) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await chrome.tabs.move(tabId, { index });
      return;
    } catch (error) {
      const message = `${error?.message ?? ''}`;
      if (attempt === retries || !message.includes('Tabs cannot be edited right now')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function moveGroup(groupId, index, retries = 2) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await chrome.tabGroups.move(groupId, { index });
      return;
    } catch (error) {
      const message = `${error?.message ?? ''}`;
      if (attempt === retries || !message.includes('Tabs cannot be edited right now')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function getMovableHighlightedItems(tabs, highlightedTabs) {
  const highlightedTabIds = new Set(highlightedTabs.map((tab) => tab.id));
  const sortedHighlightedTabs = [...highlightedTabs].sort((a, b) => a.index - b.index);
  const groupTabsById = new Map();
  const processedGroupIds = new Set();
  const items = [];

  for (const tab of tabs) {
    if (tab.groupId === TAB_GROUP_ID_NONE) continue;

    const groupTabs = groupTabsById.get(tab.groupId) ?? [];
    groupTabs.push(tab);
    groupTabsById.set(tab.groupId, groupTabs);
  }

  for (const tab of sortedHighlightedTabs) {
    if (tab.groupId === TAB_GROUP_ID_NONE) {
      items.push({ type: 'tab', tabId: tab.id, startIndex: tab.index, endIndex: tab.index });
      continue;
    }

    if (processedGroupIds.has(tab.groupId)) continue;

    const groupTabs = groupTabsById.get(tab.groupId) ?? [tab];
    const wholeGroupHighlighted = groupTabs.every((groupTab) => highlightedTabIds.has(groupTab.id));

    if (!wholeGroupHighlighted) {
      items.push({ type: 'tab', tabId: tab.id, startIndex: tab.index, endIndex: tab.index });
      continue;
    }

    processedGroupIds.add(tab.groupId);
    items.push({
      type: 'group',
      groupId: tab.groupId,
      startIndex: groupTabs[0].index,
      endIndex: groupTabs[groupTabs.length - 1].index
    });
  }

  return { items, sortedHighlightedTabs };
}

function getPinnedBoundary(tabs) {
  const firstUnpinnedIndex = tabs.findIndex((tab) => !tab.pinned);
  return {
    firstUnpinnedIndex: firstUnpinnedIndex === -1 ? tabs.length : firstUnpinnedIndex,
    lastPinnedIndex: firstUnpinnedIndex === -1 ? tabs.length - 1 : firstUnpinnedIndex - 1
  };
}

function getCollapseFocusTargetTabId(tabs, blockedGroupIds, activeTab) {
  if (!activeTab || activeTab.groupId === TAB_GROUP_ID_NONE || !blockedGroupIds.has(activeTab.groupId)) {
    return activeTab?.id ?? null;
  }

  const activeGroupTabs = tabs.filter((tab) => tab.groupId === activeTab.groupId);
  if (activeGroupTabs.length === 0) return activeTab.id;

  const groupStartIndex = activeGroupTabs[0].index;
  const groupEndIndex = activeGroupTabs[activeGroupTabs.length - 1].index;
  const rightTab = tabs.find((tab) => tab.index > groupEndIndex && !blockedGroupIds.has(tab.groupId));
  if (rightTab) return rightTab.id;

  const leftTabs = tabs.filter((tab) => tab.index < groupStartIndex && !blockedGroupIds.has(tab.groupId));
  return leftTabs[leftTabs.length - 1]?.id ?? activeTab.id;
}

async function activateRelativeTab(offset) {
  const context = await getTabContext();
  if (!context) return;

  const { activeTab, tabs } = context;
  const activePosition = tabs.findIndex((tab) => tab.id === activeTab.id);
  if (activePosition === -1) return;

  const nextPosition = (activePosition + offset + tabs.length) % tabs.length;
  await chrome.tabs.update(tabs[nextPosition].id, { active: true });
}

async function moveActiveTab(offset) {
  const context = await getTabContext();
  if (!context) return;

  const { activeTab, tabs } = context;
  const { firstUnpinnedIndex, lastPinnedIndex } = getPinnedBoundary(tabs);
  const minIndex = activeTab.pinned ? 0 : firstUnpinnedIndex;
  const maxIndex = activeTab.pinned ? lastPinnedIndex : tabs.length - 1;

  const targetIndex = Math.min(Math.max(activeTab.index + offset, minIndex), maxIndex);
  await moveTab(activeTab.id, targetIndex);
  await chrome.tabs.update(activeTab.id, { active: true });
}

async function togglePinTab() {
  const activeTab = await getActiveTab();
  if (!activeTab) return;
  await chrome.tabs.update(activeTab.id, { pinned: !activeTab.pinned });
}

async function duplicateTab() {
  const activeTab = await getActiveTab();
  if (!activeTab) return;
  await chrome.tabs.duplicate(activeTab.id);
}

async function addSelectionInDirection(offset) {
  const context = await getTabContext();
  if (!context) return;

  const { activeTab, tabs, windowId } = context;

  const targetIndex = activeTab.index + offset;
  if (targetIndex < 0 || targetIndex >= tabs.length) return;

  const highlightedIndices = tabs
    .filter((tab) => tab.highlighted)
    .map((tab) => tab.index);
  const selection = [targetIndex, ...highlightedIndices.filter((index) => index !== targetIndex)];

  await chrome.tabs.highlight({
    windowId,
    tabs: selection
  });
}

async function moveHighlightedTabs(offset) {
  const context = await getTabContext();
  if (!context) return;

  const { tabs, windowId } = context;
  const highlightedTabs = tabs.filter((tab) => tab.highlighted);

  if (highlightedTabs.length <= 1) {
    await moveActiveTab(offset);
    return;
  }

  const containsPinnedTabs = highlightedTabs.some((tab) => tab.pinned);
  const containsUnpinnedTabs = highlightedTabs.some((tab) => !tab.pinned);
  if (containsPinnedTabs && containsUnpinnedTabs) return;

  const activeHighlightedTab = highlightedTabs.find((tab) => tab.active) || highlightedTabs[0];
  const { items, sortedHighlightedTabs } = getMovableHighlightedItems(tabs, highlightedTabs);
  const { firstUnpinnedIndex, lastPinnedIndex } = getPinnedBoundary(tabs);
  const leftBoundary = containsPinnedTabs ? 0 : firstUnpinnedIndex;
  const rightBoundary = containsPinnedTabs ? lastPinnedIndex : tabs.length - 1;

  const firstIndex = items[0].startIndex;
  const lastIndex = items[items.length - 1].endIndex;

  if (offset < 0 && firstIndex === leftBoundary) return;
  if (offset > 0 && lastIndex === rightBoundary) return;

  const orderedItems = offset < 0 ? items : [...items].reverse();
  for (const item of orderedItems) {
    if (item.type === 'group') {
      await moveGroup(item.groupId, item.startIndex + offset);
      continue;
    }

    await moveTab(item.tabId, item.startIndex + offset);
  }

  const tabIds = sortedHighlightedTabs.map((tab) => tab.id);
  await restoreHighlightedTabs(windowId, tabIds, activeHighlightedTab.id);
}

async function groupSelectedTabs() {
  const context = await getTabContext();
  if (!context) return;

  const { tabs, windowId } = context;
  const highlightedTabs = tabs.filter((tab) => tab.highlighted);

  if (highlightedTabs.length === 0) return;

  const activeHighlightedTab = highlightedTabs.find((tab) => tab.active) || highlightedTabs[0];
  const tabIds = highlightedTabs.map((tab) => tab.id);
  const firstGroupId = highlightedTabs[0].groupId;
  const selectionIsSingleExistingGroup = firstGroupId !== TAB_GROUP_ID_NONE
    && highlightedTabs.every((tab) => tab.groupId === firstGroupId);

  if (selectionIsSingleExistingGroup) {
    await chrome.tabs.ungroup(tabIds);
    await restoreTabOrder(windowId, tabIds);
    await restoreHighlightedTabs(windowId, tabIds, activeHighlightedTab.id);
    return;
  }

  if (highlightedTabs.length >= 2) {
    await chrome.tabs.group({ tabIds });
    await restoreTabOrder(windowId, tabIds);
    await restoreHighlightedTabs(windowId, tabIds, activeHighlightedTab.id);
  }
}

async function collapseSelectedGroups() {
  const context = await getTabContext();
  if (!context) return;

  const { tabs, windowId } = context;
  const highlightedTabs = tabs.filter((tab) => tab.highlighted);
  if (highlightedTabs.length === 0) return;

  const activeHighlightedTab = highlightedTabs.find((tab) => tab.active) || highlightedTabs[0];
  const groupIds = [...new Set(
    highlightedTabs
      .map((tab) => tab.groupId)
      .filter((groupId) => groupId !== TAB_GROUP_ID_NONE)
  )];
  if (groupIds.length === 0) return;
  const tabGroups = await chrome.tabGroups.query({ windowId });
  const blockedGroupIds = new Set([
    ...groupIds,
    ...tabGroups.filter((group) => group.collapsed).map((group) => group.id)
  ]);
  const focusTargetTabId = getCollapseFocusTargetTabId(tabs, blockedGroupIds, activeHighlightedTab);

  for (const groupId of groupIds) {
    await chrome.tabGroups.update(groupId, { collapsed: true });
  }

  await chrome.tabs.update(focusTargetTabId, { active: true });
}

chrome.commands.onCommand.addListener(async (command) => {
  try {
    switch (command) {
      case COMMANDS.SELECT_LEFT:
        await activateRelativeTab(-1);
        break;
      case COMMANDS.SELECT_RIGHT:
        await activateRelativeTab(1);
        break;
      case COMMANDS.MOVE_LEFT:
        await moveHighlightedTabs(-1);
        break;
      case COMMANDS.MOVE_RIGHT:
        await moveHighlightedTabs(1);
        break;
      case COMMANDS.TOGGLE_PIN:
        await togglePinTab();
        break;
      case COMMANDS.DUPLICATE:
        await duplicateTab();
        break;
      case COMMANDS.ADD_SELECTION_LEFT:
        await addSelectionInDirection(-1);
        break;
      case COMMANDS.ADD_SELECTION_RIGHT:
        await addSelectionInDirection(1);
        break;
      case COMMANDS.GROUP_SELECTED:
        await groupSelectedTabs();
        break;
      case COMMANDS.TOGGLE_GROUP_COLLAPSED:
        await collapseSelectedGroups();
        break;
      default:
        break;
    }
  } catch (error) {
    console.error('Command failed', command, error);
  }
});
