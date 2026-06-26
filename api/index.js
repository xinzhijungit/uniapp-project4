const { app } = require('../server/src/index')
const path = require('path')
const express = require('express')

app.use(express.static(path.join(__dirname, '../dist/build/h5')))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../dist/build/h5/index.html'))
})

module.exports = app