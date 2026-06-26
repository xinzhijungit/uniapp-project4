const express = require('express')
const path = require('path')
const { app: serverApp } = require('../server/src/index')

const app = express()

app.use(express.static(path.join(__dirname, '../dist/build/h5')))

app.use('/api', serverApp)

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/build/h5/index.html'))
})

module.exports = app