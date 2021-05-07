<template>
  <div class="mo-task-peers">
    <div class="mo-table-wrapper">
      <el-table
        stripe
        ref="peerTable"
        class="mo-peer-table"
        :data="peers"
      >
        <el-table-column
          :label="`${$t('task.task-peer-host')}: `"
          min-width="140">
          <template slot-scope="scope">
            {{ `${scope.row.ip}:${scope.row.port}` }}
          </template>
        </el-table-column>
        <el-table-column
          :label="`${$t('task.task-peer-client')}: `"
          min-width="125">
          <template slot-scope="scope">
            {{ scope.row.peerId | peerIdParser }}
          </template>
        </el-table-column>
        <el-table-column
          :label="`%`"
          align="right"
          width="55">
          <template slot-scope="scope">
            {{ scope.row.bitfield | bitfieldToPercent }}%
          </template>
        </el-table-column>
        <el-table-column
          :label="`↑`"
          align="right"
          width="90">
          <template slot-scope="scope">
            {{ scope.row.uploadSpeed | bytesToSize }}/s
          </template>
        </el-table-column>
        <el-table-column
          :label="`↓`"
          align="right"
          width="90">
          <template slot-scope="scope">
            {{ scope.row.downloadSpeed | bytesToSize }}/s
          </template>
        </el-table-column>
      </el-table>
    </div>
  </div>
</template>

<script>
  import {
    bitfieldToPercent,
    bytesToSize,
    peerIdParser
  } from '@shared/utils'

  export default {
    name: 'mo-task-peers',
    filters: {
      bitfieldToPercent,
      bytesToSize,
      peerIdParser
    },
    props: {
      peers: {
        type: Array,
        default: function () {
          return []
        }
      }
    }
  }
</script>

<style lang="scss">
.el-table.mo-peer-table .cell {
  padding-left: 0.5rem;
  padding-right: 0.5rem;
}
</style>
