<template>
  <svg version="1.1"
    xmlns="http://www.w3.org/2000/svg"
    class="svg-task-graphic"
    :width="width"
    :height="height"
    :viewBox="box">
    <g v-for="(row, index) in atoms" :key="`g-${index}`" >
      <mo-task-graphic-atom
        v-for="atom in row"
        :key="`atom-${atom.id}`"
        :status="atom.status"
        :width="atomWidth"
        :height="atomHeight"
        :radius="atomRadius"
        :x="atom.x"
        :y="atom.y"
      />
    </g>
  </svg>
</template>

<script>
  import Atom from './Atom'

  export default {
    name: 'mo-task-graphic',
    components: {
      [Atom.name]: Atom
    },
    props: {
      bitfield: {
        type: String,
        default: ''
      },
      outerWidth: {
        type: Number,
        default: 240
      },
      atomWidth: {
        type: Number,
        default: 10
      },
      atomHeight: {
        type: Number,
        default: 10
      },
      atomGutter: {
        type: Number,
        default: 3
      },
      atomRadius: {
        type: Number,
        default: 2
      }
    },
    computed: {
      len () {
        return this.bitfield.length
      },
      atomWG () {
        return this.atomWidth + this.atomGutter
      },
      atomHG () {
        return this.atomHeight + this.atomGutter
      },
      columnCount () {
        const { outerWidth, atomWidth, atomWG } = this
        const result = parseInt((outerWidth - atomWidth) / atomWG, 10) + 1
        return result
      },
      rowCount () {
        const { len, columnCount } = this
        const result = parseInt((len / columnCount), 10) + 1
        return result
      },
      offset () {
        const { outerWidth, atomWidth, atomWG, columnCount } = this
        const totalWidth = atomWG * (columnCount - 1) + atomWidth
        const result = (outerWidth - totalWidth) / 2
        return parseFloat(result.toFixed(2))
      },
      width () {
        const { atomWidth, atomWG, columnCount } = this
        const result = atomWG * (columnCount - 1) + atomWidth
        return parseInt(result, 10)
      },
      height () {
        const { atomHeight, atomHG, rowCount, offset } = this
        const result = atomHG * (rowCount - 1) + atomHeight + offset * 2
        return parseInt(result, 10)
      },
      box () {
        return `0 0 ${this.width} ${this.height}`
      },
      atoms () {
        const { len, columnCount } = this
        const result = []
        let row = []
        for (let i = 0; i < len; i++) {
          row.push(this.buildAtom(i))

          if ((i + 1) % columnCount === 0) {
            result.push(row)
            row = []
          }
        }
        result.push(row)

        return result
      }
    },
    methods: {
      buildAtom (index) {
        const { bitfield, offset, atomWG, atomHG, columnCount } = this
        const hIndex = index + 1
        let chIndex = index % columnCount
        let rhIndex = parseInt((index / columnCount), 10)
        chIndex = chIndex < 0 ? 0 : chIndex
        rhIndex = rhIndex < 0 ? 0 : rhIndex
        const result = {
          id: `${hIndex}`,
          status: Math.floor(parseInt(bitfield[index], 16) / 4),
          x: chIndex * atomWG,
          y: offset + rhIndex * atomHG
        }

        return result
      }
    }
  }
</script>
