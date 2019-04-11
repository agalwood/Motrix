<template>
  <el-container class="panel scrapper-content" direction="vertical">
    <el-header>
      <el-input placeholder="URL" size="medium" v-model="url">
        <el-button type="primary" slot="append" icon="el-icon-search" v-on:click="fetch()" />
      </el-input>
    </el-header>
    <el-main>
      <div v-show="tableData.length > 0 ===false" style="text-align:center">
        <h4 style="color:grey">NO DATA</h4>
        <svg version="1.1" width="100" height="50">
          <circle cx=65 cy=25 r=20 fill="#333534"></circle>
          <circle cx=30 cy=30 r=15 fill="#222323"></circle>
          <circle cx=50 cy=25 r=25 fill="#5DF4A8"></circle>
        </svg>
      </div>
      <el-table
        v-show="tableData.length > 0"
        size="medium"
        :data="tableData"
        @selection-change="handleSelectionChange"
      >
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
          :filters="typefilters"
          :filter-method="filterHandler"
          label="Typ">
        </el-table-column>
        <el-table-column
          property="size"
          label="Size"
          width="80">
        </el-table-column>
        <el-table-column
          property="url"
          label="URL"
          show-overflow-tooltip>
        </el-table-column>
      </el-table>
    </el-main>
    <el-footer>
      <br>
      <el-button
        v-show="tableData.length > 0"
        type="primary"
        v-bind:disabled="multipleSelection.length > 0 === false"
      >Add selected files</el-button>
    </el-footer>
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
        multipleSelection: [],
        typefilters: []
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
            this.typefilters = [...new Set(t.map(x => x.type))]
              .map(f => {
                return {
                  text: f,
                  value: f
                }
              })
              .sort((a, b) => {
                a = a.text.toLowerCase()
                b = b.text.toLowerCase()
                if (a < b) {
                  return -1
                }
                if (a > b) {
                  return 1
                }
                return 0
              })
          })
        }
      },
      handleSelectionChange (val) {
        this.multipleSelection = val
      },
      filterHandler (value, row, column) {
        const property = column['property']
        return row[property] === value
      }
    }
  }
</script>

<style lang="scss">
  .scrapper-content{
    padding-top:15px;
  }
</style>