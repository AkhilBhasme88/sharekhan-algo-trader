<template>
  <div v-if="visibleRows.length" class="table-wrap">
    <table>
      <thead>
        <tr>
          <th v-for="col in columns" :key="col">{{ col }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, i) in visibleRows"
          :key="i"
          :class="{ clickable }"
          @click="clickable && $emit('row-click', row)"
        >
          <td v-for="col in columns" :key="col">{{ formatCell(row[col]) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="truncated" class="table-note">Showing first {{ maxRows }} of {{ rows.length }} rows.</p>
  </div>
  <p v-else class="table-note">No rows to show.</p>
</template>

<script setup>
import { computed } from "vue";

// Generic on purpose: several of the APIs this app talks to have real
// column names that are unverified until you have a live response in
// front of you (the scrip master CSV, Sharekhan's raw historical
// payload) — rather than hardcoding a column list that would silently
// show blank cells the moment it's wrong, this reads whatever keys the
// actual rows carry.
const props = defineProps({
  rows: { type: Array, default: () => [] },
  clickable: { type: Boolean, default: false },
  maxColumns: { type: Number, default: 10 },
  maxRows: { type: Number, default: 200 },
});
defineEmits(["row-click"]);

// Column set is the union of keys across every visible row, not just
// the first — scrip-master/holdings rows can be sparse or
// inconsistent — capped at maxColumns so a wide, messy dataset doesn't
// produce an unreadably wide table.
const visibleRows = computed(() => props.rows.slice(0, props.maxRows));
const truncated = computed(() => props.rows.length > props.maxRows);

const columns = computed(() => {
  const keys = new Set();
  for (const row of visibleRows.value) {
    if (row && typeof row === "object") Object.keys(row).forEach((k) => keys.add(k));
  }
  return Array.from(keys).slice(0, props.maxColumns);
});

function formatCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
</script>

<style scoped>
.table-wrap {
  overflow-x: auto;
  max-height: 320px;
  overflow-y: auto;
  border: 1px solid #262a33;
  border-radius: 8px;
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 0.78rem;
}
th,
td {
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid #262a33;
  white-space: nowrap;
}
th {
  position: sticky;
  top: 0;
  background: #171a21;
  color: #9aa0aa;
  font-weight: 600;
}
tbody tr:hover {
  background: #14161c;
}
tr.clickable {
  cursor: pointer;
}
tr.clickable:hover {
  background: #1a2030;
}
.table-note {
  color: #9aa0aa;
  font-size: 0.75rem;
  padding: 0.4rem 0.6rem;
  margin: 0;
}
</style>
