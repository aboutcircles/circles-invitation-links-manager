import { onWalletChange, signMessage, sendTransactions } from '@aboutcircles/miniapp-sdk';
import { Distributions, Referrals } from '@aboutcircles/sdk-referrals';
import { CirclesRpc, PagedQuery } from '@aboutcircles/sdk-rpc';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { encodeFunctionData, encodeAbiParameters, keccak256, encodePacked, createPublicClient, http } from 'viem';
import { gnosis } from 'viem/chains';

// ── Config ────────────────────────────────────────────────────────────────────

const AUTH_BASE      = 'https://staging.circlesubi.network/auth';
const REFERRALS_BASE = 'https://staging.circlesubi.network/referrals';
const SESSION_BASE   = 'https://circles.gnosis.io/invitation';

// ── State ─────────────────────────────────────────────────────────────────────

let connectedAddress = null;
let authToken        = null;
let currentChallenge = null;  // { challengeId, message }
let currentSession   = null;  // session object being viewed
let keysOffset       = 0;
const KEYS_PAGE      = 50;
let selectedExpiry   = 0;     // days; 0 = no expiry

// My Invites pagination
let myInvitesOffset  = 0;
const MY_INVITES_PAGE = 50;
let myInvitesTotal   = 0;

let currentSessions   = [];         // cache for session picker
let assignTargetKeys  = [];         // [{ id }] being assigned in modal
let myInvitesKeyMap   = new Map();  // referral id → full privateKey (from listMine)
const selectedRefIds  = new Set();  // currently checked referral ids in My Invites

// ── SDK clients ───────────────────────────────────────────────────────────────

const distributions = new Distributions(REFERRALS_BASE, () => Promise.resolve(authToken));
const referrals     = new Referrals(REFERRALS_BASE, () => Promise.resolve(authToken));
const rpc           = new CirclesRpc('https://rpc.circlesubi.network/');

// ── BaseGroup trustBatchWithConditions ABI (minimal) ─────────────────────────

const BASE_GROUP_ABI = [{
  type: 'function',
  name: 'trustBatchWithConditions',
  inputs: [
    { name: '_members', type: 'address[]' },
    { name: '_expiry',  type: 'uint96'    },
  ],
  outputs: [],
  stateMutability: 'nonpayable',
}];

const MAX_UINT96 = 2n ** 96n - 1n;

// ── Invitation contracts ───────────────────────────────────────────────────────

const INVITATION_FARM    = '0xd28b7C4f148B1F1E190840A1f7A796C5525D8902';
const INVITATION_MODULE  = '0x00738aca013B7B2e6cfE1690F0021C3182Fa40B5';
const REFERRALS_MODULE   = '0x12105a9b291af2abb0591001155a75949b062ce5';
const HUB                = '0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8';
const INVITATION_FEE     = 96n * 10n ** 18n;

const INVITATION_FARM_ABI = [
  {
    type: 'function',
    name: 'inviterQuota',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'claimInvites',
    inputs: [{ name: 'numberOfInvites', type: 'uint256' }],
    outputs: [{ name: 'ids', type: 'uint256[]' }],
    stateMutability: 'nonpayable',
  },
];

const HUB_BATCH_TRANSFER_ABI = [{
  type: 'function',
  name: 'safeBatchTransferFrom',
  inputs: [
    { name: 'from',   type: 'address'   },
    { name: 'to',     type: 'address'   },
    { name: 'ids',    type: 'uint256[]' },
    { name: 'values', type: 'uint256[]' },
    { name: 'data',   type: 'bytes'     },
  ],
  outputs: [],
  stateMutability: 'nonpayable',
}];

const REFERRALS_MODULE_ABI = [{
  type: 'function',
  name: 'createAccounts',
  inputs: [{ name: 'signers', type: 'address[]' }],
  outputs: [{ name: '_accounts', type: 'address[]' }],
  stateMutability: 'nonpayable',
}];

const publicClient = createPublicClient({ chain: gnosis, transport: http('https://rpc.gnosischain.com') });

// ── Helpers ───────────────────────────────────────────────────────────────────

function show(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showResult(el, type, html) {
  el.className = `result ${type} show`;
  el.innerHTML = html;
}

function clearResult(el) {
  el.className = 'result';
  el.innerHTML = '';
}

function shortAddr(addr) {
  if (!addr) return '—';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function keyPreview(pk) {
  if (!pk) return '—';
  return pk.slice(0, 8) + '…' + pk.slice(-4);
}

function formatExpiry(iso) {
  if (!iso) return null;
  const d    = new Date(iso);
  const diff = d - new Date();
  if (diff < 0) return { label: 'Expired', soon: true };
  const days = Math.floor(diff / 86400000);
  if (days === 0) return { label: 'Expires today', soon: true };
  if (days === 1) return { label: 'Expires tomorrow', soon: false };
  return { label: `Expires in ${days}d`, soon: false };
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Session params (localStorage) ────────────────────────────────────────────

const PARAMS_KEY = 'circles-session-params'; // { [sessionId]: "key=val&..." }

function getSessionParams(sessionId) {
  try {
    const all = JSON.parse(localStorage.getItem(PARAMS_KEY) || '{}');
    return all[sessionId] || '';
  } catch { return ''; }
}

function setSessionParams(sessionId, params) {
  try {
    const all = JSON.parse(localStorage.getItem(PARAMS_KEY) || '{}');
    if (params) all[sessionId] = params;
    else delete all[sessionId];
    localStorage.setItem(PARAMS_KEY, JSON.stringify(all));
  } catch {}
}

function buildSessionLink(sessionId, slug) {
  const params = getSessionParams(sessionId);
  const base   = `${SESSION_BASE}/${slug}`;
  return params ? `${base}?${params}` : base;
}

function copySessionLink(sessionId, slug, btn) {
  const link = buildSessionLink(sessionId, slug);
  navigator.clipboard.writeText(link).then(() => {
    btn.classList.add('copied');
    btn.innerHTML = '✓ Copied';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = '🔗 Copy invitation link';
    }, 2000);
  }).catch(() => {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = link;
    ta.style.position = 'fixed';
    ta.style.opacity  = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.classList.add('copied');
    btn.innerHTML = '✓ Copied';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = '🔗 Copy invitation link';
    }, 2000);
  });
}

// ── Group trust ───────────────────────────────────────────────────────────────

/**
 * Fetch all groups where connectedAddress is owner OR service.
 * GroupQueryParams only supports ownerIn, so we do two queries and merge.
 */
async function fetchControlledGroups(address) {
  const lower = address.toLowerCase();

  // Query 1: owner
  const byOwner = await rpc.group.findGroups(200, { ownerIn: [address] });

  // Query 2: service — no built-in filter, use PagedQuery with raw filter
  const serviceQuery = new PagedQuery(rpc.client, {
    namespace: 'V_CrcV2',
    table: 'Groups',
    sortOrder: 'DESC',
    columns: ['blockNumber','timestamp','transactionIndex','logIndex','transactionHash',
              'group','type','owner','service','name','symbol'],
    filter: [{
      Type: 'FilterPredicate',
      FilterType: 'Equals',
      Column: 'service',
      Value: lower,
    }],
    limit: 200,
  });

  const byService = [];
  while (await serviceQuery.queryNextPage()) {
    const rows = serviceQuery.currentPage?.results ?? [];
    if (!rows.length) break;
    byService.push(...rows);
  }

  // Merge, deduplicate by group address
  const seen = new Set();
  const all  = [];
  for (const g of [...byOwner, ...byService]) {
    const addr = (g.group || '').toLowerCase();
    if (!seen.has(addr)) {
      seen.add(addr);
      // Annotate role so we can show it in UI
      const isOwner   = (g.owner   || '').toLowerCase() === lower;
      const isService = (g.service || '').toLowerCase() === lower;
      all.push({ ...g, _role: isOwner ? 'owner' : isService ? 'service' : 'owner' });
    }
  }
  return all;
}

// ── Address derivation (mirrors invitation_at_scale_backend/src/lib/address-derivation.ts) ──

const SAFE_PROXY_FACTORY        = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const ACCOUNT_CREATION_CODE_HASH = '0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee';
const ACCOUNT_INITIALIZER_HASH   = '0x89867a67674bd4bf33165a653cde826b696ab7d050166b71066dfa0b9b6f90f4';

/**
 * Compute the deterministic Safe account address for an invitation private key.
 * privateKey → signerAddress (EOA) → CREATE2 Safe address (via ReferralsModule).
 */
function deriveAccountAddress(privateKey) {
  const signer = privateKeyToAccount(privateKey).address;

  const salt = keccak256(
    encodePacked(['bytes32', 'uint256'], [ACCOUNT_INITIALIZER_HASH, BigInt(signer)])
  );

  const create2Hash = keccak256(
    encodePacked(
      ['bytes1', 'address', 'bytes32', 'bytes32'],
      ['0xff', SAFE_PROXY_FACTORY, salt, ACCOUNT_CREATION_CODE_HASH]
    )
  );

  return ('0x' + create2Hash.slice(-40));
}

/**
 * Fetch all current group members (trusted addresses) for a group.
 */
async function fetchGroupMembers(groupAddress) {
  const query  = rpc.group.getGroupMembers(groupAddress, 1000);
  const addrs  = new Set();
  while (await query.queryNextPage()) {
    const rows = query.currentPage?.results ?? [];
    if (!rows.length) break;
    for (const r of rows) addrs.add((r.member || '').toLowerCase());
    if (!query.currentPage?.hasMore) break;
  }
  return addrs;
}

// ── Session group assignment (localStorage) ───────────────────────────────────

const SESSION_GROUP_KEY = 'circles-session-group'; // { [sessionId]: { group, name, role } | null }

function getSessionGroup(sessionId) {
  try {
    const all = JSON.parse(localStorage.getItem(SESSION_GROUP_KEY) || '{}');
    return all[sessionId] || null;
  } catch { return null; }
}

function setSessionGroup(sessionId, groupEntry) {
  try {
    const all = JSON.parse(localStorage.getItem(SESSION_GROUP_KEY) || '{}');
    if (groupEntry) all[sessionId] = groupEntry;
    else delete all[sessionId];
    localStorage.setItem(SESSION_GROUP_KEY, JSON.stringify(all));
  } catch {}
}

// ── Group assignment UI ───────────────────────────────────────────────────────

let controlledGroups = [];  // loaded lazily, cached per login session

function renderGroupAssignRow(sessionId) {
  const assigned = getSessionGroup(sessionId);
  const valueEl  = document.getElementById('groupAssignValue');
  if (assigned) {
    valueEl.innerHTML = `<a href="https://app.gnosis.io/${escapeAttr(assigned.group)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:inherit;" onclick="event.stopPropagation()">${escapeHtml(assigned.name || assigned.group)}</a>`;
    valueEl.classList.remove('none');
    // clicks on the link should not open the picker
    valueEl.onclick = null;
    valueEl.querySelector('a').addEventListener('click', e => e.stopPropagation());
  } else {
    valueEl.textContent = 'No group';
    valueEl.classList.add('none');
    valueEl.onclick = openGroupPickModal;
  }
  clearResult(document.getElementById('groupAssignResult'));
}

// ── Core trust/untrust helpers ────────────────────────────────────────────────

/** Load all private keys for a session (all pages). */
async function loadAllSessionKeys(sessionId) {
  const keys = [];
  let offset = 0;
  const PAGE = 200;
  while (true) {
    const data = await distributions.listKeys(sessionId, { limit: PAGE, offset });
    if (!data.keys?.length) break;
    keys.push(...data.keys);
    offset += data.keys.length;
    if (offset >= data.total) break;
  }
  return keys;
}

/** Derive account addresses from a list of key objects. */
function deriveAddresses(keys) {
  return keys
    .filter(k => k.privateKey)
    .map(k => { try { return deriveAccountAddress(k.privateKey); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Trust a set of addresses in a group — skips already-trusted ones.
 * Returns tx hashes.
 */
async function trustAddressesInGroup(groupAddress, addresses) {
  if (!addresses.length) return [];
  const existing = await fetchGroupMembers(groupAddress);
  const toTrust  = addresses.filter(a => !existing.has(a.toLowerCase()));
  if (!toTrust.length) return [];

  const txs = [];
  // trustBatchWithConditions accepts up to ~200 at a time safely
  const BATCH = 200;
  for (let i = 0; i < toTrust.length; i += BATCH) {
    const chunk = toTrust.slice(i, i + BATCH);
    txs.push({
      to:    groupAddress,
      data:  encodeFunctionData({ abi: BASE_GROUP_ABI, functionName: 'trustBatchWithConditions', args: [chunk, MAX_UINT96] }),
      value: '0',
    });
  }
  const hashes = await sendTransactions(txs);
  return hashes;
}

/**
 * Untrust (set expiry=0) a set of addresses in a group.
 * Returns tx hashes.
 */
async function untrustAddressesInGroup(groupAddress, addresses) {
  if (!addresses.length) return [];
  const existing = await fetchGroupMembers(groupAddress);
  // Only untrust those that are actually members
  const toUntrust = addresses.filter(a => existing.has(a.toLowerCase()));
  if (!toUntrust.length) return [];

  const txs = [];
  const BATCH = 200;
  for (let i = 0; i < toUntrust.length; i += BATCH) {
    const chunk = toUntrust.slice(i, i + BATCH);
    txs.push({
      to:    groupAddress,
      data:  encodeFunctionData({ abi: BASE_GROUP_ABI, functionName: 'trustBatchWithConditions', args: [chunk, 0n] }),
      value: '0',
    });
  }
  const hashes = await sendTransactions(txs);
  return hashes;
}

// ── Group picker modal ────────────────────────────────────────────────────────

document.getElementById('groupAssignBtn').addEventListener('click', openGroupPickModal);
document.getElementById('groupAssignValue').addEventListener('click', openGroupPickModal);
document.getElementById('cancelGroupPickBtn').addEventListener('click', () => {
  document.getElementById('groupPickModal').classList.remove('show');
});

async function openGroupPickModal() {
  const list   = document.getElementById('groupPickList');
  const result = document.getElementById('groupPickResult');
  clearResult(result);
  document.getElementById('groupPickModal').classList.add('show');

  // Load groups if not yet cached
  if (!controlledGroups.length) {
    list.innerHTML = '<div class="empty-state">Loading groups…</div>';
    try {
      controlledGroups = await fetchControlledGroups(connectedAddress);
    } catch (e) {
      list.innerHTML = `<div class="empty-state" style="color:#b91c1c;">Error: ${escapeHtml(e.message)}</div>`;
      return;
    }
  }

  if (!controlledGroups.length) {
    list.innerHTML = '<div class="empty-state">No groups found where you are owner or service.</div>';
    return;
  }

  const assigned = getSessionGroup(currentSession?.id);

  list.innerHTML = controlledGroups.map((g, i) => {
    const isSelected = assigned && assigned.group.toLowerCase() === g.group.toLowerCase();
    return `
      <div class="group-pick-item${isSelected ? ' selected' : ''}" data-group-idx="${i}">
        <span class="group-pick-name">${escapeHtml(g.name || g.group)}</span>
        <span class="group-pick-role">${escapeHtml(g._role)}</span>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.group-pick-item').forEach(item => {
    item.addEventListener('click', () => {
      const g = controlledGroups[parseInt(item.dataset.groupIdx)];
      selectSessionGroup(currentSession?.id, g);
    });
  });

  // "None" item — highlighted when no group assigned
  const noneItem = document.getElementById('groupPickNone');
  noneItem.classList.toggle('selected', !assigned);
  noneItem.onclick = () => removeSessionGroup(currentSession?.id, true);
}

async function selectSessionGroup(sessionId, newGroup) {
  if (!sessionId) return;
  const result   = document.getElementById('groupPickResult');
  const oldGroup = getSessionGroup(sessionId);

  // No-op if same group selected
  if (oldGroup && oldGroup.group.toLowerCase() === newGroup.group.toLowerCase()) {
    document.getElementById('groupPickModal').classList.remove('show');
    return;
  }

  showResult(result, 'pending', 'Loading session keys…');
  const keys      = await loadAllSessionKeys(sessionId).catch(e => { showResult(result, 'error', e.message); return null; });
  if (!keys) return;

  const addresses = deriveAddresses(keys);
  const txs = [];

  // Untrust from old group
  if (oldGroup && addresses.length) {
    showResult(result, 'pending', `Untrusting from ${escapeHtml(oldGroup.name || oldGroup.group)}…`);
    const existing = await fetchGroupMembers(oldGroup.group);
    const toUntrust = addresses.filter(a => existing.has(a.toLowerCase()));
    if (toUntrust.length) {
      const BATCH = 200;
      for (let i = 0; i < toUntrust.length; i += BATCH) {
        const chunk = toUntrust.slice(i, i + BATCH);
        txs.push({ to: oldGroup.group, data: encodeFunctionData({ abi: BASE_GROUP_ABI, functionName: 'trustBatchWithConditions', args: [chunk, 0n] }), value: '0' });
      }
    }
  }

  // Trust in new group
  if (addresses.length) {
    showResult(result, 'pending', `Trusting in ${escapeHtml(newGroup.name || newGroup.group)}…`);
    const existing = await fetchGroupMembers(newGroup.group);
    const toTrust  = addresses.filter(a => !existing.has(a.toLowerCase()));
    if (toTrust.length) {
      const BATCH = 200;
      for (let i = 0; i < toTrust.length; i += BATCH) {
        const chunk = toTrust.slice(i, i + BATCH);
        txs.push({ to: newGroup.group, data: encodeFunctionData({ abi: BASE_GROUP_ABI, functionName: 'trustBatchWithConditions', args: [chunk, MAX_UINT96] }), value: '0' });
      }
    }
  }

  try {
    if (txs.length) {
      showResult(result, 'pending', `Sending ${txs.length} transaction(s)…`);
      await sendTransactions(txs);
    }
    setSessionGroup(sessionId, { group: newGroup.group, name: newGroup.name || newGroup.group, role: newGroup._role });
    document.getElementById('groupPickModal').classList.remove('show');
    renderGroupAssignRow(sessionId);
  } catch (e) {
    showResult(result, 'error', 'Failed: ' + e.message);
  }
}

async function removeSessionGroup(sessionId, fromModal = false) {
  if (!sessionId) return;
  const oldGroup = getSessionGroup(sessionId);
  if (fromModal) document.getElementById('groupPickModal').classList.remove('show');
  if (!oldGroup) return;

  const result = document.getElementById('groupAssignResult');
  showResult(result, 'pending', 'Loading session keys…');

  try {
    const keys      = await loadAllSessionKeys(sessionId);
    const addresses = deriveAddresses(keys);

    if (addresses.length) {
      showResult(result, 'pending', `Untrusting from ${escapeHtml(oldGroup.name || oldGroup.group)}…`);
      const existing  = await fetchGroupMembers(oldGroup.group);
      const toUntrust = addresses.filter(a => existing.has(a.toLowerCase()));
      if (toUntrust.length) {
        const txs = [];
        const BATCH = 200;
        for (let i = 0; i < toUntrust.length; i += BATCH) {
          const chunk = toUntrust.slice(i, i + BATCH);
          txs.push({ to: oldGroup.group, data: encodeFunctionData({ abi: BASE_GROUP_ABI, functionName: 'trustBatchWithConditions', args: [chunk, 0n] }), value: '0' });
        }
        await sendTransactions(txs);
      }
    }

    setSessionGroup(sessionId, null);
    renderGroupAssignRow(sessionId);
    clearResult(result);
  } catch (e) {
    showResult(result, 'error', 'Failed: ' + e.message);
  }
}

// ── My Invites ────────────────────────────────────────────────────────────────

async function loadMyInvites(reset = false) {
  if (reset) myInvitesOffset = 0;
  const content = document.getElementById('myInvitesContent');
  if (reset) content.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const data = await referrals.listMine({
      limit: MY_INVITES_PAGE,
      offset: myInvitesOffset,
    });

    // Keep key map in sync so assign can always resolve full private keys
    for (const ref of data.referrals) {
      myInvitesKeyMap.set(ref.id, ref.privateKey);
    }

    myInvitesTotal = data.total;

    if (reset) {
      content.innerHTML = '';
      selectedRefIds.clear();
    }

    if (!data.referrals.length && myInvitesOffset === 0) {
      content.innerHTML = '<div class="empty-state">No invitation codes yet.<br>Add keys above to get started.</div>';
      updateBulkAssignBar();
      return;
    }

    content.querySelector('.load-more-btn')?.remove();
    content.querySelector('.claimed-toggle')?.remove();
    content.querySelector('.claimed-list')?.remove();

    const active  = data.referrals.filter(r => r.status !== 'claimed' && !r.sessions.length);
    const claimed = data.referrals.filter(r => r.status === 'claimed');

    // Insert select-all row on first load
    if (myInvitesOffset === 0 && active.length) {
      let selectAllRow = document.getElementById('selectAllRow');
      if (!selectAllRow) {
        selectAllRow = document.createElement('div');
        selectAllRow.id = 'selectAllRow';
        selectAllRow.className = 'invite-row select-all-row';
        selectAllRow.innerHTML = `
          <input type="checkbox" id="selectAllChk" class="invite-checkbox">
          <label for="selectAllChk" style="font-size:12px;color:#6a6c8c;cursor:pointer;flex:1;">Select all</label>
        `;
        selectAllRow.querySelector('#selectAllChk').addEventListener('change', (e) => {
          const checked = e.target.checked;
          content.querySelectorAll('.invite-checkbox[data-ref-id]').forEach(chk => {
            chk.checked = checked;
            if (checked) selectedRefIds.add(chk.dataset.refId);
            else selectedRefIds.delete(chk.dataset.refId);
          });
          updateBulkAssignBar();
        });
        content.insertBefore(selectAllRow, content.firstChild);
      }
    }

    for (const ref of active) {
      const row = document.createElement('div');
      row.className = 'invite-row';

      const pillHtml = ref.status === 'confirmed'
        ? '<span class="pill pill-active">Confirmed</span>'
        : '<span class="pill pill-pool">Pool</span>';

      row.innerHTML = `
        <input type="checkbox" class="invite-checkbox" data-ref-id="${escapeAttr(ref.id)}" ${selectedRefIds.has(ref.id) ? 'checked' : ''}>
        <span class="key-addr">${escapeHtml(keyPreview(ref.privateKey))}</span>
        ${pillHtml}
      `;

      row.querySelector('.invite-checkbox').addEventListener('change', (e) => {
        if (e.target.checked) selectedRefIds.add(ref.id);
        else selectedRefIds.delete(ref.id);
        syncSelectAll();
        updateBulkAssignBar();
      });

      content.appendChild(row);
    }

    // Claimed collapsed section
    if (claimed.length) {
      const toggle = document.createElement('button');
      toggle.className = 'claimed-toggle load-more-btn';
      toggle.textContent = `${claimed.length} claimed invite${claimed.length === 1 ? '' : 's'}`;

      const claimedList = document.createElement('div');
      claimedList.className = 'claimed-list';
      claimedList.style.display = 'none';

      for (const ref of claimed) {
        const row = document.createElement('div');
        row.className = 'invite-row';
        row.innerHTML = `
          <span style="width:16px;flex-shrink:0;"></span>
          <span class="key-addr">${escapeHtml(keyPreview(ref.privateKey))}</span>
          <span class="pill pill-claimed">Claimed</span>
          ${ref.accountAddress ? `<span style="font-size:10px;color:#9b9db3;">${shortAddr(ref.accountAddress)}</span>` : ''}
        `;
        claimedList.appendChild(row);
      }

      toggle.addEventListener('click', () => {
        const open = claimedList.style.display !== 'none';
        claimedList.style.display = open ? 'none' : '';
        toggle.textContent = open
          ? `${claimed.length} claimed invite${claimed.length === 1 ? '' : 's'}`
          : 'Hide claimed';
      });

      content.appendChild(toggle);
      content.appendChild(claimedList);
    }

    myInvitesOffset += data.referrals.length;

    if (myInvitesOffset < data.total) {
      const btn = document.createElement('button');
      btn.className = 'load-more-btn';
      btn.textContent = `Load more (${data.total - myInvitesOffset} remaining)`;
      btn.addEventListener('click', () => loadMyInvites(false));
      content.appendChild(btn);
    }

    updateBulkAssignBar();

  } catch (e) {
    if (reset) content.innerHTML = `<div class="empty-state" style="color:#b91c1c;">Error: ${e.message}</div>`;
  }
}


// ── Selection helpers ─────────────────────────────────────────────────────────

function syncSelectAll() {
  const all  = document.querySelectorAll('#myInvitesContent .invite-checkbox[data-ref-id]');
  const chkd = document.querySelectorAll('#myInvitesContent .invite-checkbox[data-ref-id]:checked');
  const selectAll = document.getElementById('selectAllChk');
  if (!selectAll) return;
  selectAll.indeterminate = chkd.length > 0 && chkd.length < all.length;
  selectAll.checked = all.length > 0 && chkd.length === all.length;
}

function updateBulkAssignBar() {
  const bar = document.getElementById('bulkAssignBar');
  const count = selectedRefIds.size;
  if (count === 0) {
    bar.style.display = 'none';
  } else {
    bar.style.display = 'flex';
    document.getElementById('bulkAssignCount').textContent = `${count} selected`;
  }
}

// ── Assign modal ──────────────────────────────────────────────────────────────

async function openAssignModal(refEntry) {
  // refEntry can be a single { id } or null (bulk — use selectedRefIds)
  assignTargetKeys = refEntry
    ? [refEntry]
    : [...selectedRefIds].map(id => ({ id }));
  const list = document.getElementById('assignSessionList');
  clearResult(document.getElementById('assignResult'));

  // Refresh session cache if empty
  if (!currentSessions.length) {
    try {
      const data = await distributions.listSessions(connectedAddress, { limit: 100 });
      currentSessions = data.sessions || [];
    } catch (e) { /* show empty state below */ }
  }

  const activeSessions = currentSessions.filter(s => !s.paused);

  if (!activeSessions.length) {
    list.innerHTML = '<div class="empty-state">No active sessions available.<br>Create a session first.</div>';
  } else {
    list.innerHTML = activeSessions.map(s => {
      const expiry = formatExpiry(s.expiresAt);
      const expiryStr = expiry ? ` · ${expiry.label}` : '';
      return `
        <div class="assign-session-item" data-session-id="${escapeAttr(s.id)}" data-session-label="${escapeAttr(s.label || s.slug)}">
          <div>
            <div class="session-label">${escapeHtml(s.label || '(unnamed)')}</div>
            <div class="session-slug">/${escapeHtml(s.slug)}${escapeHtml(expiryStr)}</div>
          </div>
          <span style="font-size:11px;color:#6a6c8c;">${(s.queuedCount ?? 0) + (s.dispatchedCount ?? 0) + (s.claimedCount ?? 0)} total</span>
        </div>
      `;
    }).join('');

    list.querySelectorAll('.assign-session-item').forEach(item => {
      item.addEventListener('click', () => doAssignToSession(item.dataset.sessionId, item.dataset.sessionLabel));
    });
  }

  document.getElementById('assignModal').classList.add('show');
}

async function doAssignToSession(sessionId, sessionLabel) {
  const result = document.getElementById('assignResult');
  if (!assignTargetKeys.length || !sessionId) return;

  const keys = assignTargetKeys.map(t => myInvitesKeyMap.get(t.id)).filter(Boolean);
  if (!keys.length) {
    showResult(result, 'error', 'Keys not found in cache. Please sign out and sign back in.');
    return;
  }

  showResult(result, 'pending', `Assigning ${keys.length} key${keys.length === 1 ? '' : 's'}…`);

  try {
    // addKeys max 100 per call
    for (let i = 0; i < keys.length; i += 100) {
      await distributions.addKeys(sessionId, keys.slice(i, i + 100));
    }

    // If the target session has a group, trust the newly assigned keys in it
    const targetGroup = getSessionGroup(sessionId);
    if (targetGroup) {
      showResult(result, 'pending', `Trusting in group ${escapeHtml(targetGroup.name)}…`);
      const addresses = keys.map(pk => { try { return deriveAccountAddress(pk); } catch { return null; } }).filter(Boolean);
      if (addresses.length) await trustAddressesInGroup(targetGroup.group, addresses);
    }

    assignTargetKeys = [];
    selectedRefIds.clear();
    document.getElementById('assignModal').classList.remove('show');

    const data = await distributions.listSessions(connectedAddress, { limit: 100 });
    currentSessions = data.sessions || [];
    loadMyInvites(true);
  } catch (e) {
    showResult(result, 'error', 'Failed: ' + e.message);
  }
}

document.getElementById('cancelAssignBtn').addEventListener('click', () => {
  assignTargetKeys = [];
  document.getElementById('assignModal').classList.remove('show');
});

document.getElementById('bulkAssignBtn').addEventListener('click', () => {
  if (!selectedRefIds.size) return;
  openAssignModal(null);
});

document.getElementById('bulkClearBtn').addEventListener('click', () => {
  selectedRefIds.clear();
  document.querySelectorAll('#myInvitesContent .invite-checkbox').forEach(chk => { chk.checked = false; });
  syncSelectAll();
  updateBulkAssignBar();
});

// ── Auth flow ─────────────────────────────────────────────────────────────────

const statusEl  = document.getElementById('status');
const authPanel = document.getElementById('auth-panel');

onWalletChange((address) => {
  connectedAddress = address;
  currentChallenge = null;
  authToken        = null;

  if (address) {
    statusEl.className = 'status connected';
    statusEl.innerHTML = 'Connected: <span class="addr">' + shortAddr(address) + '</span>';
    authPanel.style.display = '';
  } else {
    statusEl.className = 'status disconnected';
    statusEl.textContent = 'Waiting for wallet connection…';
    authPanel.style.display = 'none';
  }
});

// Single-click sign-in: fetch challenge then sign immediately
document.getElementById('challengeBtn').addEventListener('click', async () => {
  if (!connectedAddress) return;
  const btn    = document.getElementById('challengeBtn');
  const result = document.getElementById('challengeResult');

  btn.disabled = true;
  clearResult(result);
  showResult(result, 'pending', 'Fetching challenge…');

  try {
    const challengeRes = await fetch(`${AUTH_BASE}/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: connectedAddress,
        chainId: 100,
        statement: 'Sign in to Circles Referrals',
        audience: 'referrals-api',
      }),
    });

    if (!challengeRes.ok) {
      const err = await challengeRes.json().catch(() => ({ error: challengeRes.statusText }));
      throw new Error(err.error || `HTTP ${challengeRes.status}`);
    }

    const { challengeId, message } = await challengeRes.json();

    showResult(result, 'pending', 'Waiting for wallet signature…');
    const { signature } = await signMessage(message, 'raw');

    showResult(result, 'pending', 'Verifying…');
    const verifyRes = await fetch(`${AUTH_BASE}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId, signature }),
    });

    if (!verifyRes.ok) {
      const err = await verifyRes.json().catch(() => ({ error: verifyRes.statusText }));
      throw new Error(err.error || `HTTP ${verifyRes.status}`);
    }

    const data    = await verifyRes.json();
    authToken     = data.token;
    clearResult(result);
    show('view-sessions');
    setSessionsTabActive();
    loadSessions();
  } catch (e) {
    showResult(result, 'error', 'Failed: ' + e.message);
    btn.disabled = false;
  }
});


// Sign out
function signOut() {
  authToken      = null;
  currentSession = null;
  show('view-auth');
}

document.getElementById('signOutBtn').addEventListener('click', signOut);
document.getElementById('myInvitesSignOutBtn').addEventListener('click', signOut);

// ── Nav tabs ──────────────────────────────────────────────────────────────────

function setSessionsTabActive() {
  document.querySelectorAll('.nav-tab-sessions').forEach(t => t.classList.add('active'));
  document.querySelectorAll('.nav-tab-invites').forEach(t => t.classList.remove('active'));
}

function setMyInvitesTabActive() {
  document.querySelectorAll('.nav-tab-sessions').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-tab-invites').forEach(t => t.classList.add('active'));
}

document.querySelectorAll('.nav-tab-sessions').forEach(btn => {
  btn.addEventListener('click', () => {
    setSessionsTabActive();
    show('view-sessions');
    loadSessions();
  });
});

document.querySelectorAll('.nav-tab-invites').forEach(btn => {
  btn.addEventListener('click', () => {
    setMyInvitesTabActive();
    show('view-myinvites');
    loadMyInvites(true);
  });
});

// ── Add keys to pool panel ────────────────────────────────────────────────────

document.getElementById('addToPoolBtn').addEventListener('click', () => {
  const panel = document.getElementById('addToPoolPanel');
  panel.style.display = panel.style.display === 'none' ? '' : 'none';
});

document.getElementById('cancelAddToPoolBtn').addEventListener('click', () => {
  document.getElementById('addToPoolPanel').style.display = 'none';
  document.getElementById('poolKeysInput').value = '';
  clearResult(document.getElementById('addToPoolResult'));
});

document.getElementById('submitPoolKeysBtn').addEventListener('click', async () => {
  const raw    = document.getElementById('poolKeysInput').value.trim();
  const result = document.getElementById('addToPoolResult');
  const btn    = document.getElementById('submitPoolKeysBtn');

  if (!raw) return;

  const keys = raw.split('\n')
    .map(l => l.trim())
    .filter(l => /^0x[a-fA-F0-9]{64}$/.test(l));

  if (!keys.length) {
    showResult(result, 'error', 'No valid keys found. Keys must be 0x + 64 hex characters.');
    return;
  }

  btn.disabled = true;
  showResult(result, 'pending', `Storing ${keys.length} key(s)…`);

  try {
    // storeBatch max 200 per call
    let totalStored = 0, totalFailed = 0;

    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200);
      const invitations = chunk.map(pk => ({ privateKey: pk, inviter: connectedAddress }));
      const data = await referrals.storeBatch(invitations);
      totalStored += data.stored;
      totalFailed += data.failed;
    }

    let msg = `Stored <strong>${totalStored}</strong> key(s).`;
    if (totalFailed) msg += ` ${totalFailed} failed (duplicate or invalid).`;
    showResult(result, 'success', msg);
    document.getElementById('poolKeysInput').value = '';
    loadMyInvites(true);
  } catch (e) {
    showResult(result, 'error', 'Failed: ' + e.message);
  }

  btn.disabled = false;
});

// ── Sessions list ─────────────────────────────────────────────────────────────

async function loadSessions() {
  const content = document.getElementById('sessionsContent');
  content.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const data = await distributions.listSessions(connectedAddress, { limit: 100 });
    currentSessions = data.sessions || [];
    renderSessions(currentSessions);
  } catch (e) {
    content.innerHTML = `<div class="empty-state" style="color:#b91c1c;">Error: ${e.message}</div>`;
  }
}

function renderSessions(sessions) {
  const content = document.getElementById('sessionsContent');

  if (!sessions.length) {
    content.innerHTML = '<div class="empty-state">No sessions yet.<br>Create one to start distributing invites.</div>';
    return;
  }

  content.innerHTML = sessions.map(s => {
    const expiry = formatExpiry(s.expiresAt);
    const statusPill = s.paused
      ? '<span class="pill pill-paused">Paused</span>'
      : expiry?.soon
        ? '<span class="pill pill-expired">Expiring</span>'
        : '<span class="pill pill-active">Active</span>';

    const expiryTag = expiry
      ? `<span class="expiry-tag${expiry.soon ? ' soon' : ''}">${expiry.label}</span>`
      : '';

    const hasParams = !!getSessionParams(s.id);

    return `
      <div class="session-card" data-id="${s.id}">
        <div class="session-card-header">
          <span class="session-label">${escapeHtml(s.label || '(unnamed)')}</span>
          ${statusPill}
        </div>
        <div class="session-stats">
          <div class="stat-item">
            <span class="stat-num">${(s.queuedCount ?? 0) + (s.dispatchedCount ?? 0) + (s.claimedCount ?? 0)}</span>
            <span>Total</span>
          </div>
          <div class="stat-item">
            <span class="stat-num green">${s.claimedCount ?? '—'}</span>
            <span>Claimed</span>
          </div>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;">
          <span class="session-slug">/${escapeHtml(s.slug)}</span>
          <div style="display:flex;align-items:center;gap:4px;">
            ${expiryTag}
            <button class="btn-copy-link" data-copy-id="${escapeAttr(s.id)}" data-copy-slug="${escapeAttr(s.slug)}">🔗 Copy invitation link</button>
            <button class="btn-params${hasParams ? ' has-params' : ''}" data-params-id="${escapeAttr(s.id)}" title="Custom GET parameters">⚙ GET params</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  content.querySelectorAll('.session-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.btn-copy-link') || e.target.closest('.btn-params')) return;
      const session = sessions.find(s => s.id === card.dataset.id);
      openSession(session);
    });
  });

  content.querySelectorAll('.btn-copy-link[data-copy-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      copySessionLink(btn.dataset.copyId, btn.dataset.copySlug, btn);
    });
  });

  content.querySelectorAll('.btn-params[data-params-id]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openParamsModal(btn.dataset.paramsId);
    });
  });
}

// ── Create session modal ──────────────────────────────────────────────────────

document.getElementById('newSessionBtn').addEventListener('click', () => {
  clearResult(document.getElementById('createResult'));
  document.getElementById('newLabel').value = '';
  selectedExpiry = 0;
  document.querySelectorAll('.expiry-opt').forEach(o => {
    o.classList.toggle('selected', parseInt(o.dataset.days) === 0);
  });
  document.getElementById('createModal').classList.add('show');
});

document.querySelectorAll('.expiry-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('.expiry-opt').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    selectedExpiry = parseInt(opt.dataset.days);
  });
});

document.getElementById('cancelCreateBtn').addEventListener('click', () => {
  document.getElementById('createModal').classList.remove('show');
});

document.getElementById('confirmCreateBtn').addEventListener('click', async () => {
  const btn    = document.getElementById('confirmCreateBtn');
  const result = document.getElementById('createResult');
  const label  = document.getElementById('newLabel').value.trim();

  btn.disabled = true;
  showResult(result, 'pending', 'Creating session…');

  try {
    const body = { inviterAddress: connectedAddress };
    if (label) body.label = label;
    if (selectedExpiry > 0) {
      const exp = new Date();
      exp.setDate(exp.getDate() + selectedExpiry);
      body.expiresAt = exp.toISOString();
    }

    const session = await distributions.createSession(body);
    document.getElementById('createModal').classList.remove('show');
    // Refresh cache then open new session
    const data = await distributions.listSessions(connectedAddress, { limit: 100 });
    currentSessions = data.sessions || [];
    openSession(session);
  } catch (e) {
    showResult(result, 'error', 'Failed: ' + e.message);
    btn.disabled = false;
  }
});

// ── Session detail ────────────────────────────────────────────────────────────

function openSession(session) {
  currentSession = session;
  keysOffset = 0;
  renderSessionDetail(session);
  clearAddKeysPanel();
  renderGroupAssignRow(session.id);
  clearResult(document.getElementById('generateResult'));
  show('view-detail');
  loadKeys(true);
  loadQuota();
}

function renderSessionDetail(s) {
  document.getElementById('detailLabel').textContent = s.label || '(unnamed)';

  const expiry    = formatExpiry(s.expiresAt);
  const expiryStr = expiry ? ` · ${expiry.label}` : '';
  document.getElementById('detailMeta').textContent =
    `/${s.slug} · ${s.paused ? 'Paused' : 'Active'}${expiryStr}`;

  const total   = (s.queuedCount ?? 0) + (s.dispatchedCount ?? 0) + (s.claimedCount ?? 0);
  const claimed = s.claimedCount ?? 0;
  document.getElementById('statsSummary').textContent = `${claimed} claimed, ${total} total`;

  const pauseBtn = document.getElementById('pauseBtn');
  pauseBtn.textContent = s.paused ? 'Resume' : 'Pause';

  // Render copy link + params buttons in detail header
  const hasParams = !!getSessionParams(s.id);
  let detailActions = document.getElementById('detailLinkActions');
  if (!detailActions) {
    detailActions = document.createElement('div');
    detailActions.id = 'detailLinkActions';
    detailActions.style.cssText = 'display:flex;gap:6px;margin-top:8px;';
    document.getElementById('detailMeta').after(detailActions);
  }
  detailActions.innerHTML = `
    <button class="btn-copy-link" id="detailCopyBtn">🔗 Copy invitation link</button>
    <button class="btn-params${hasParams ? ' has-params' : ''}" id="detailParamsBtn">⚙ GET params</button>
  `;
  document.getElementById('detailCopyBtn').addEventListener('click', () => {
    copySessionLink(s.id, s.slug, document.getElementById('detailCopyBtn'));
  });
  document.getElementById('detailParamsBtn').addEventListener('click', () => {
    openParamsModal(s.id);
  });
}

// ── Quota & generate invitations ─────────────────────────────────────────────

async function loadQuota() {
  const row    = document.getElementById('quotaRow');
  const valEl  = document.getElementById('quotaValue');
  row.style.display = 'none';
  if (!connectedAddress) return;

  try {
    const quota = await publicClient.readContract({
      address: INVITATION_FARM,
      abi: INVITATION_FARM_ABI,
      functionName: 'inviterQuota',
      args: [connectedAddress],
    });
    if (quota > 0n) {
      valEl.textContent = quota.toString();
      const maxCount = Math.min(20, Number(quota));
      const countInput = document.getElementById('generateCount');
      countInput.max   = maxCount;
      if (parseInt(countInput.value, 10) > maxCount) countInput.value = maxCount;
      row.style.display = 'flex';
    }
  } catch { /* non-fatal — hide row */ }
}

document.getElementById('generateInvitesBtn').addEventListener('click', generateInvitations);

async function generateInvitations() {
  const btn    = document.getElementById('generateInvitesBtn');
  const result = document.getElementById('generateResult');
  const countInput = document.getElementById('generateCount');
  const COUNT  = Math.min(20, Math.max(1, parseInt(countInput.value, 10) || 20));

  btn.disabled = true;
  clearResult(result);
  showResult(result, 'pending', 'Generating keypairs…');

  try {
    // 1. Generate 20 keypairs
    const keypairs = Array.from({ length: COUNT }, () => {
      const privateKey    = generatePrivateKey();
      const signerAddress = privateKeyToAccount(privateKey).address;
      return { privateKey, signerAddress };
    });

    const signers = keypairs.map(k => k.signerAddress);

    // 2. Simulate claimInvites to get the bot token IDs
    showResult(result, 'pending', 'Fetching invitation token IDs…');
    const botTokenIds = await publicClient.readContract({
      address: INVITATION_FARM,
      abi: INVITATION_FARM_ABI,
      functionName: 'claimInvites',
      args: [BigInt(COUNT)],
      account: connectedAddress,
    });
    if (!botTokenIds || botTokenIds.length !== COUNT) {
      throw new Error(`Expected ${COUNT} token IDs but got ${botTokenIds?.length ?? 0}`);
    }

    // 3. Encode ReferralsModule.createAccounts call
    const createAccountsCall = encodeFunctionData({
      abi: REFERRALS_MODULE_ABI,
      functionName: 'createAccounts',
      args: [signers],
    });
    const genericCallData = encodeAbiParameters(
      [{ type: 'address' }, { type: 'bytes' }],
      [REFERRALS_MODULE, createAccountsCall]
    );

    // 4. Build two txs: claimInvites + safeBatchTransferFrom with bot token IDs
    const claimData = encodeFunctionData({
      abi: INVITATION_FARM_ABI,
      functionName: 'claimInvites',
      args: [BigInt(COUNT)],
    });
    const values = botTokenIds.map(() => INVITATION_FEE);
    const transferData = encodeFunctionData({
      abi: HUB_BATCH_TRANSFER_ABI,
      functionName: 'safeBatchTransferFrom',
      args: [connectedAddress, INVITATION_MODULE, botTokenIds, values, genericCallData],
    });

    showResult(result, 'pending', 'Waiting for wallet confirmation…');
    await sendTransactions([
      { to: INVITATION_FARM, data: claimData, value: '0' },
      { to: HUB,             data: transferData, value: '0' },
    ]);

    // 4. Store batch in referrals API
    showResult(result, 'pending', 'Storing invitations in API…');
    const invitations = keypairs.map(k => ({ privateKey: k.privateKey, inviter: connectedAddress }));
    for (let i = 0; i < invitations.length; i += 200) {
      await referrals.storeBatch(invitations.slice(i, i + 200));
    }

    // 5. Add keys to current session
    showResult(result, 'pending', 'Adding to session…');
    const privateKeys = keypairs.map(k => k.privateKey);
    for (let i = 0; i < privateKeys.length; i += 100) {
      await distributions.addKeys(currentSession.id, privateKeys.slice(i, i + 100));
    }

    // 6. Trust in group if assigned
    const sessionGroup = getSessionGroup(currentSession.id);
    if (sessionGroup) {
      showResult(result, 'pending', `Trusting in group ${escapeHtml(sessionGroup.name)}…`);
      const addresses = keypairs.map(k => deriveAccountAddress(k.privateKey)).filter(Boolean);
      if (addresses.length) await trustAddressesInGroup(sessionGroup.group, addresses);
    }

    // 7. Refresh quota and session view
    await loadQuota();
    await refreshDetail();
    showResult(result, 'success', `Generated and added <strong>${COUNT}</strong> invitations to this session.`);
  } catch (e) {
    showResult(result, 'error', 'Failed: ' + e.message);
  }

  btn.disabled = false;
}

document.getElementById('backBtn').addEventListener('click', () => {
  currentSession = null;
  show('view-sessions');
  setSessionsTabActive();
  loadSessions();
});

document.getElementById('refreshDetailBtn').addEventListener('click', refreshDetail);

async function refreshDetail() {
  if (!currentSession) return;
  const spinner = document.getElementById('refreshSpinner');
  spinner.style.display = '';
  try {
    const s = await distributions.getSession(currentSession.id);
    currentSession = s;
    renderSessionDetail(s);
    keysOffset = 0;
    await loadKeys(true);
  } catch (e) {
    // silent — keys load will show error
  }
  spinner.style.display = 'none';
}

// Pause / Resume
document.getElementById('pauseBtn').addEventListener('click', async () => {
  if (!currentSession) return;
  const btn = document.getElementById('pauseBtn');
  btn.disabled = true;

  try {
    const s = await distributions.updateSession(currentSession.id, {
      paused: !currentSession.paused,
    });
    currentSession = s;
    renderSessionDetail(s);
  } catch (e) {
    alert('Failed: ' + e.message);
  }

  btn.disabled = false;
});

document.getElementById('cancelAddKeysBtn').addEventListener('click', clearAddKeysPanel);

function clearAddKeysPanel() {
  document.getElementById('addKeysPanel').style.display = 'none';
  document.getElementById('keysInput').value = '';
  clearResult(document.getElementById('addKeysResult'));
}

document.getElementById('submitKeysBtn').addEventListener('click', async () => {
  const raw    = document.getElementById('keysInput').value.trim();
  const result = document.getElementById('addKeysResult');

  if (!raw) return;

  const keys = raw.split('\n')
    .map(l => l.trim())
    .filter(l => /^0x[a-fA-F0-9]{64}$/.test(l));

  if (!keys.length) {
    showResult(result, 'error', 'No valid keys found. Keys must be 0x + 64 hex characters.');
    return;
  }

  const btn = document.getElementById('submitKeysBtn');
  btn.disabled = true;
  showResult(result, 'pending', `Adding ${keys.length} key(s)…`);

  try {
    let totalAdded = 0, totalSkipped = 0, totalClaimed = 0;
    const allErrors = [];

    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const data  = await distributions.addKeys(currentSession.id, chunk);
      totalAdded   += data.added   || 0;
      totalSkipped += data.skipped || 0;
      totalClaimed += data.claimed || 0;
      if (data.errors?.length) allErrors.push(...data.errors);
    }

    let msg = `Added <strong>${totalAdded}</strong> key(s).`;
    if (totalSkipped) msg += ` ${totalSkipped} skipped (duplicate).`;
    if (totalClaimed) msg += ` ${totalClaimed} already claimed.`;
    if (allErrors.length) msg += `<br>${allErrors.length} error(s).`;

    showResult(result, 'success', msg);
    document.getElementById('keysInput').value = '';
    await refreshDetail();
  } catch (e) {
    showResult(result, 'error', 'Failed: ' + e.message);
  }

  btn.disabled = false;
});

// ── Keys list ─────────────────────────────────────────────────────────────────

async function loadKeys(reset = false) {
  if (reset) keysOffset = 0;
  const list = document.getElementById('keysList');
  if (reset) list.innerHTML = '<div style="font-size:12px;color:#9b9db3;padding:8px 0;">Loading invites…</div>';

  try {
    const data = await distributions.listKeys(currentSession.id, {
      limit: KEYS_PAGE,
      offset: keysOffset,
    });

    if (reset) list.innerHTML = '';

    if (!data.keys?.length && keysOffset === 0) {
      list.innerHTML = '<div class="empty-state" style="padding:16px 0;">No invites yet — add keys above.</div>';
      return;
    }

    list.querySelector('.load-more-btn')?.remove();
    list.querySelector('.claimed-toggle')?.remove();
    list.querySelector('.claimed-list')?.remove();

    const active  = data.keys.filter(k => k.status !== 'claimed');
    const claimed = data.keys.filter(k => k.status === 'claimed');

    function makeKeyRow(k) {
      const row         = document.createElement('div');
      row.className     = 'key-row';
      const preview     = k.privateKey ? keyPreview(k.privateKey) : '—';
      const acct        = k.accountAddress
        ? `<span style="font-size:10px;color:#9b9db3;">${shortAddr(k.accountAddress)}</span>`
        : '';

      let actionsHtml = '';
      if (k.status === 'queued') {
        actionsHtml = `
          <div class="key-actions">
            <button class="btn-xs" data-action="reassign" title="Move to another session">↔ Reassign</button>
            <button class="btn-xs danger" data-action="removekey" title="Remove from session">✕</button>
          </div>`;
      }

      row.innerHTML = `
        <span class="key-addr">${preview}</span>
        ${acct}
        <span class="key-status status-${k.status}">${k.status}</span>
        ${actionsHtml}
      `;

      if (k.status === 'queued') {
        row.querySelector('[data-action="reassign"]')?.addEventListener('click', (e) => {
          e.stopPropagation();
          openReassignModal(k, row);
        });
        row.querySelector('[data-action="removekey"]')?.addEventListener('click', async (e) => {
          e.stopPropagation();
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await distributions.removeKey(currentSession.id, k.id);

            // Untrust from session's group if one is assigned
            const sessionGroup = getSessionGroup(currentSession.id);
            if (sessionGroup && k.privateKey) {
              try {
                const addr = deriveAccountAddress(k.privateKey);
                await untrustAddressesInGroup(sessionGroup.group, [addr]);
              } catch { /* non-fatal */ }
            }

            row.remove();
            const summaryEl = document.getElementById('statsSummary');
            const m = summaryEl.textContent.match(/(\d+) claimed, (\d+) total/);
            if (m) summaryEl.textContent = `${m[1]} claimed, ${Math.max(0, parseInt(m[2]) - 1)} total`;
          } catch (err) {
            alert('Failed to remove: ' + err.message);
            btn.disabled = false;
          }
        });
      }

      return row;
    }

    for (const k of active) {
      list.appendChild(makeKeyRow(k));
    }

    if (claimed.length) {
      const toggle = document.createElement('button');
      toggle.className = 'claimed-toggle load-more-btn';
      toggle.textContent = `${claimed.length} claimed invite${claimed.length === 1 ? '' : 's'}`;

      const claimedList = document.createElement('div');
      claimedList.className = 'claimed-list';
      claimedList.style.display = 'none';
      for (const k of claimed) claimedList.appendChild(makeKeyRow(k));

      toggle.addEventListener('click', () => {
        const open = claimedList.style.display !== 'none';
        claimedList.style.display = open ? 'none' : '';
        toggle.textContent = open
          ? `${claimed.length} claimed invite${claimed.length === 1 ? '' : 's'}`
          : 'Hide claimed';
      });

      list.appendChild(toggle);
      list.appendChild(claimedList);
    }

    keysOffset += data.keys.length;

    if (keysOffset < data.total) {
      const btn = document.createElement('button');
      btn.className   = 'load-more-btn';
      btn.textContent = `Load more (${data.total - keysOffset} remaining)`;
      btn.addEventListener('click', () => loadKeys(false));
      list.appendChild(btn);
    }
  } catch (e) {
    if (reset) list.innerHTML = `<div class="empty-state" style="color:#b91c1c;">Error: ${e.message}</div>`;
  }
}

// ── Reassign key to another session ──────────────────────────────────────────

let reassignKey = null;   // { id, privateKey, row }

function openReassignModal(keyEntry, row) {
  reassignKey = { ...keyEntry, row };
  const list = document.getElementById('reassignSessionList');
  clearResult(document.getElementById('reassignResult'));

  const otherSessions = currentSessions.filter(s => s.id !== currentSession?.id && !s.paused);

  if (!otherSessions.length) {
    list.innerHTML = '<div class="empty-state">No other active sessions available.</div>';
  } else {
    list.innerHTML = otherSessions.map(s => `
      <div class="assign-session-item" data-session-id="${escapeAttr(s.id)}" data-session-label="${escapeAttr(s.label || s.slug)}">
        <div>
          <div class="session-label">${escapeHtml(s.label || '(unnamed)')}</div>
          <div class="session-slug">/${escapeHtml(s.slug)}</div>
        </div>
        <span style="font-size:11px;color:#6a6c8c;">${(s.queuedCount ?? 0) + (s.dispatchedCount ?? 0) + (s.claimedCount ?? 0)} total</span>
      </div>
    `).join('');

    list.querySelectorAll('.assign-session-item').forEach(item => {
      item.addEventListener('click', () => doReassign(item.dataset.sessionId, item.dataset.sessionLabel));
    });
  }

  document.getElementById('reassignModal').classList.add('show');
}

async function doReassign(targetSessionId, targetSessionLabel) {
  const result = document.getElementById('reassignResult');
  if (!reassignKey || !targetSessionId) return;

  const btn = document.getElementById('cancelReassignBtn');
  btn.disabled = true;
  showResult(result, 'pending', 'Moving key…');

  try {
    // Add to target session first, then remove from current
    await distributions.addKeys(targetSessionId, [reassignKey.privateKey]);
    await distributions.removeKey(currentSession.id, reassignKey.id);

    // Handle group trust changes
    const sourceGroup = getSessionGroup(currentSession.id);
    const targetGroup = getSessionGroup(targetSessionId);
    let accountAddr;
    try { accountAddr = deriveAccountAddress(reassignKey.privateKey); } catch {}

    if (accountAddr) {
      const txs = [];
      if (sourceGroup) {
        const existing = await fetchGroupMembers(sourceGroup.group);
        if (existing.has(accountAddr.toLowerCase())) {
          txs.push({ to: sourceGroup.group, data: encodeFunctionData({ abi: BASE_GROUP_ABI, functionName: 'trustBatchWithConditions', args: [[accountAddr], 0n] }), value: '0' });
        }
      }
      if (targetGroup) {
        const existing = await fetchGroupMembers(targetGroup.group);
        if (!existing.has(accountAddr.toLowerCase())) {
          txs.push({ to: targetGroup.group, data: encodeFunctionData({ abi: BASE_GROUP_ABI, functionName: 'trustBatchWithConditions', args: [[accountAddr], MAX_UINT96] }), value: '0' });
        }
      }
      if (txs.length) {
        showResult(result, 'pending', 'Updating group membership…');
        await sendTransactions(txs);
      }
    }

    reassignKey.row?.remove();
    document.getElementById('reassignModal').classList.remove('show');
    reassignKey = null;

    // Refresh session cache
    const data = await distributions.listSessions(connectedAddress, { limit: 100 });
    currentSessions = data.sessions || [];

    const summaryEl = document.getElementById('statsSummary');
    const m = summaryEl.textContent.match(/(\d+) claimed, (\d+) total/);
    if (m) summaryEl.textContent = `${m[1]} claimed, ${Math.max(0, parseInt(m[2]) - 1)} total`;
  } catch (e) {
    showResult(result, 'error', 'Failed: ' + e.message);
    btn.disabled = false;
  }
}

document.getElementById('cancelReassignBtn').addEventListener('click', () => {
  reassignKey = null;
  document.getElementById('reassignModal').classList.remove('show');
});

// ── Custom params modal ───────────────────────────────────────────────────────

let paramsTargetSessionId = null;

function openParamsModal(sessionId) {
  paramsTargetSessionId = sessionId;
  document.getElementById('paramsInput').value = getSessionParams(sessionId);
  clearResult(document.getElementById('paramsResult'));
  document.getElementById('paramsModal').classList.add('show');
}

document.getElementById('cancelParamsBtn').addEventListener('click', () => {
  paramsTargetSessionId = null;
  document.getElementById('paramsModal').classList.remove('show');
});

document.getElementById('saveParamsBtn').addEventListener('click', () => {
  if (!paramsTargetSessionId) return;
  const raw    = document.getElementById('paramsInput').value.trim();
  const result = document.getElementById('paramsResult');

  // Basic validation: should look like key=value pairs
  if (raw && !/^[^=&]+=/.test(raw)) {
    showResult(result, 'error', 'Invalid format. Use key=value pairs separated by &amp;');
    return;
  }

  setSessionParams(paramsTargetSessionId, raw);
  document.getElementById('paramsModal').classList.remove('show');

  // Refresh button states wherever visible
  document.querySelectorAll(`.btn-params[data-params-id="${paramsTargetSessionId}"]`).forEach(btn => {
    btn.classList.toggle('has-params', !!raw);
  });
  const detailParamsBtn = document.getElementById('detailParamsBtn');
  if (detailParamsBtn && currentSession?.id === paramsTargetSessionId) {
    detailParamsBtn.classList.toggle('has-params', !!raw);
  }

  paramsTargetSessionId = null;
});
