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

  const targetIndex = Math.min(Math.max(activeTab.index + offset, 0), tabs.length - 1);
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

  const activeHighlightedTab = highlightedTabs.find((tab) => tab.active) || highlightedTabs[0];
  highlightedTabs.sort((a, b) => a.index - b.index);

  const firstIndex = highlightedTabs[0].index;
  const lastIndex = highlightedTabs[highlightedTabs.length - 1].index;

  if (offset < 0 && firstIndex === 0) return;
  if (offset > 0 && lastIndex === tabs.length - 1) return;

  const orderedTabs = offset < 0 ? highlightedTabs : [...highlightedTabs].reverse();
  for (const tab of orderedTabs) {
    await moveTab(tab.id, tab.index + offset);
  }

  const tabIds = highlightedTabs.map((tab) => tab.id);
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

  const { tabs } = context;
  const highlightedTabs = tabs.filter((tab) => tab.highlighted);
  if (highlightedTabs.length === 0) return;

  const activeHighlightedTab = highlightedTabs.find((tab) => tab.active) || highlightedTabs[0];
  const groupIds = [...new Set(
    highlightedTabs
      .map((tab) => tab.groupId)
      .filter((groupId) => groupId !== TAB_GROUP_ID_NONE)
  )];
  if (groupIds.length === 0) return;

  for (const groupId of groupIds) {
    await chrome.tabGroups.update(groupId, { collapsed: true });
  }

  await chrome.tabs.update(activeHighlightedTab.id, { active: true });
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
