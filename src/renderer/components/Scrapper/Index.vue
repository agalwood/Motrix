<template>
  <el-container class="content panel scrapper-content" direction="horizontal">
    <el-main>
      <el-input placeholder="URL" size="medium" v-model="url">
        <el-button type="primary" slot="append" icon="el-icon-search" v-on:click="fetch()" />
      </el-input>
        <el-table
    :data="tableData"
    @selection-change="handleSelectionChange">
    <el-table-column
      type="selection"
      size="medium"
      width="50">
    </el-table-column>
    <el-table-column
      property="name"
      sortable
      label="Name"
      show-overflow-tooltip>
    </el-table-column>
    <el-table-column
      property="type"
      sortable
      label="Typ">
    </el-table-column>
    <el-table-column
      property="size"
      label="Size">
    </el-table-column>
    <el-table-column
      property="url"
      label="URL"
      show-overflow-tooltip>
    </el-table-column>
  </el-table>
    </el-main>
  </el-container>
</template>

<script>
  import scrap from '@/components/Scrapper/scrapper'

  export default {
    name: 'mo-content-scrapper',
    data: () => {
      return {
        url: '',
        tableData: [],
        multipleSelection: []
      }
    },
    created () {
      this.fetch()
    },
    methods: {
      fetch () {
        if (this.url !== '') {
          scrap(this.url, (t) => {
            this.tableData = t
          })
        }
      },
      handleSelectionChange (val) {
        this.multipleSelection = val
      }
    }
  }
</script>

<style lang="scss">
  .scrapper-content{
    padding: 15px;
  }
</style>