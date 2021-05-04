<template>
  <el-form
    ref="form"
    :model="form"
    :label-width="formLabelWidth"
    v-if="task"
  >
    <div
      class="tracker-list"
      v-if="announceList"
    >
      <el-input
        readonly
        type="textarea"
        :autosize="{ minRows: 12, maxRows: 24}"
        auto-complete="off"
        v-model="announceList">
      </el-input>
    </div>
  </el-form>
</template>

<script>
  import is from 'electron-is'
  import {
    calcFormLabelWidth,
    checkTaskIsBT,
    checkTaskIsSeeder
  } from '@shared/utils'
  import { convertTrackerDataToLine } from '@shared/utils/tracker'
  import { EMPTY_STRING } from '@shared/constants'

  export default {
    name: 'mo-task-trackers',
    props: {
      task: {
        type: Object
      }
    },
    data () {
      const { locale } = this.$store.state.preference.config
      return {
        form: {},
        formLabelWidth: calcFormLabelWidth(locale),
        locale
      }
    },
    computed: {
      isRenderer: () => is.renderer(),
      isBT () {
        return checkTaskIsBT(this.task)
      },
      isSeeder () {
        return checkTaskIsSeeder(this.task)
      },
      announceList () {
        if (!this.isBT) {
          return EMPTY_STRING
        }

        const { bittorrent } = this.task
        const data = bittorrent.announceList.map((i) => i[0])
        return convertTrackerDataToLine(data)
      }
    },
    methods: {
    }
  }
</script>

<style lang="scss">
.tracker-list {
  padding: 0;
  margin: 0;
  font-size: $--font-size-small;
  textarea {
    line-height: 2;
  }
}
</style>
