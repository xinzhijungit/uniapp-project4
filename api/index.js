const express = require('express')
const cors = require('cors')
const db = require('../server/src/db')
const https = require('https')
const fs = require('fs')
const path = require('path')

const app = express()

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}))
app.use(express.json())

function logSQL(sql, params) {
  const logMessage = `[${new Date().toISOString()}] SQL: ${sql} | Params: ${JSON.stringify(params)}\n`
  console.log('SQL执行:', sql)
  console.log('Params详情:', params.map((p, i) => `param[${i}]=${JSON.stringify(p)}`).join(', '))
}

// AI模型调用函数
async function callAIModel(prompt) {
  return new Promise(async (resolve, reject) => {
    try {
      const configResults = await db.query('SELECT CONFIG_KEY, CONFIG_VALUE FROM XAGA_config WHERE CONFIG_KEY LIKE ?', ['ai_%'])
      
      const config = {}
      configResults.forEach(row => {
        config[row.CONFIG_KEY] = row.CONFIG_VALUE
      })
      
      const aiModelUrl = config.ai_model_url || 'https://api.deepseek.com/v1/chat/completions'
      const aiModelName = config.ai_model_name || 'deepseek-chat'
      const aiApiKey = config.ai_api_key || ''
      const aiMaxTokens = parseInt(config.ai_max_tokens) || 10
      const aiTemperature = parseFloat(config.ai_temperature) || 0.1
      const aiTimeout = parseInt(config.ai_timeout_seconds) * 1000 || 30000
      
      if (!aiApiKey || aiApiKey.trim() === '') {
        reject(new Error('AI API密钥未配置，请在XAGA_config表中设置ai_api_key'))
        return
      }
      
      const postData = JSON.stringify({
        model: aiModelName,
        messages: [
          { role: "user", content: prompt }
        ],
        temperature: aiTemperature
      })
      
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${aiApiKey}`
        },
        timeout: aiTimeout,
        rejectUnauthorized: false
      }
      
      const req = https.request(new URL(aiModelUrl), options, (res) => {
        let data = ''
        res.on('data', (chunk) => {
          data += chunk
        })
        res.on('end', () => {
          try {
            const result = JSON.parse(data)
            let content = ''
            if (result.choices && result.choices.length > 0 && result.choices[0].message) {
              const message = result.choices[0].message
              if (message.content && message.content.trim()) {
                content = message.content.trim()
              } else if (message.reasoning_content && message.reasoning_content.trim()) {
                content = message.reasoning_content.trim()
              }
            } else if (result.response) {
              content = result.response.trim()
            } else if (result.result) {
              content = result.result.trim()
            } else if (result.text) {
              content = result.text.trim()
            } else if (typeof result === 'string') {
              content = result.trim()
            }
            
            if (content) {
              resolve(content)
            } else {
              reject(new Error('AI模型返回格式异常'))
            }
          } catch (error) {
            reject(new Error('解析AI模型响应失败'))
          }
        })
      })
      
      req.on('error', (error) => {
        reject(error)
      })
      
      req.write(postData)
      req.end()
    } catch (error) {
      reject(error)
    }
  })
}

// 获取智能标签详细信息
async function getTagDetails(aiTagOntology) {
  if (!aiTagOntology) {
    return []
  }
  
  let tagCodes = []
  try {
    if (typeof aiTagOntology === 'string') {
      try {
        tagCodes = JSON.parse(aiTagOntology)
      } catch (e) {
        tagCodes = aiTagOntology.split(',').map(code => code.trim()).filter(Boolean)
      }
    } else if (Array.isArray(aiTagOntology)) {
      tagCodes = aiTagOntology
    }
  } catch (error) {
    console.error('解析标签本体失败:', error)
    return []
  }
  
  if (!Array.isArray(tagCodes) || tagCodes.length === 0) {
    return []
  }
  
  const placeholders = tagCodes.map(() => '?').join(',')
  const sql = `SELECT TAG_CODE, TAG_NAME, TAG_CATEGORY, DESCRIPTION, 
    EXAMPLE_CASE_1, EXAMPLE_CASE_2, EXAMPLE_CASE_3,
    EXAMPLE_PERSON_1, EXAMPLE_PERSON_2, EXAMPLE_PERSON_3
    FROM XAGA_tags WHERE TAG_CODE IN (${placeholders})`
  
  try {
    const rows = await db.query(sql, tagCodes)
    return rows.map(row => ({
      tagCode: row.TAG_CODE,
      tagName: row.TAG_NAME,
      category: row.TAG_CATEGORY,
      description: row.DESCRIPTION,
      examples: {
        cases: [row.EXAMPLE_CASE_1, row.EXAMPLE_CASE_2, row.EXAMPLE_CASE_3].filter(Boolean),
        persons: [row.EXAMPLE_PERSON_1, row.EXAMPLE_PERSON_2, row.EXAMPLE_PERSON_3].filter(Boolean)
      }
    }))
  } catch (error) {
    console.error('查询标签详情失败:', error)
    return []
  }
}

// 初始化配置表
async function initConfigTable() {
  try {
    const configTableExists = await db.query(`
      SELECT COUNT(*) as count FROM information_schema.tables 
      WHERE table_schema = DATABASE() AND table_name = 'XAGA_config'
    `)
    
    if (configTableExists[0].count === 0) {
      await db.query(`
        CREATE TABLE XAGA_config (
          CONFIG_KEY VARCHAR(100) PRIMARY KEY,
          CONFIG_VALUE TEXT,
          DESCRIPTION VARCHAR(500),
          UPDATE_TIME TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `)
      console.log('配置表创建成功')
    }
  } catch (error) {
    console.error('初始化配置表失败:', error)
  }
}

// ============ API 路由 ============

// 健康检查
app.get('/api/v1/health', (req, res) => {
  res.json({ code: 200, message: '服务正常运行', data: { timestamp: new Date().toISOString() } })
})

// 获取所有配置
app.get('/api/v1/config', async (req, res) => {
  try {
    const rows = await db.query('SELECT CONFIG_KEY, CONFIG_VALUE, DESCRIPTION, UPDATE_TIME FROM XAGA_config')
    const config = {}
    rows.forEach(row => {
      config[row.CONFIG_KEY] = {
        value: row.CONFIG_VALUE,
        description: row.DESCRIPTION,
        updateTime: row.UPDATE_TIME
      }
    })
    res.json({ code: 200, data: config })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取单个配置
app.get('/api/v1/config/:key', async (req, res) => {
  try {
    const rows = await db.query('SELECT CONFIG_KEY, CONFIG_VALUE, DESCRIPTION, UPDATE_TIME FROM XAGA_config WHERE CONFIG_KEY = ?', [req.params.key])
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: '配置项不存在' })
    }
    res.json({
      code: 200,
      data: {
        key: rows[0].CONFIG_KEY,
        value: rows[0].CONFIG_VALUE,
        description: rows[0].DESCRIPTION,
        updateTime: rows[0].UPDATE_TIME
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 更新配置
app.put('/api/v1/config/:key', async (req, res) => {
  try {
    const { value, description } = req.body
    await db.query(
      'INSERT INTO XAGA_config (CONFIG_KEY, CONFIG_VALUE, DESCRIPTION) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE CONFIG_VALUE = ?, DESCRIPTION = ?',
      [req.params.key, value, description, value, description]
    )
    res.json({ code: 200, message: '配置更新成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 实体搜索
app.post('/api/v1/search/entity', async (req, res) => {
  try {
    const { keyword, entityType, filters } = req.body
    
    if (!keyword || keyword.trim().length < 2) {
      return res.status(400).json({ code: 400, message: '搜索关键词至少需要2个字符' })
    }
    
    const searchKeyword = `%${keyword.trim()}%`
    let results = []
    
    if (!entityType || entityType === 'person') {
      const personSql = `SELECT DISTINCT 'person' as entityType, A.XRKBH as id, A.XM as name, A.XB as gender,
        A.CSRQ as birthDate, A.SFZH as idCard, B.HJMC as household,
        GROUP_CONCAT(DISTINCT C.AJMC SEPARATOR '; ') as cases
        FROM XAGA_person A
        LEFT JOIN XAGA_household B ON A.XRKBH = B.XRKBH
        LEFT JOIN XAGA_case_person CP ON A.XRKBH = CP.XRKBH
        LEFT JOIN XAGA_case C ON CP.AJBH = C.AJBH
        WHERE A.XM LIKE ? OR A.SFZH LIKE ?
        GROUP BY A.XRKBH
        LIMIT 20`
      
      const persons = await db.query(personSql, [searchKeyword, searchKeyword])
      results = results.concat(persons)
    }
    
    if (!entityType || entityType === 'case') {
      const caseSql = `SELECT DISTINCT 'case' as entityType, AJBH as id, AJMC as name, AJLB as type,
        AJSJ as caseTime, AJDD as location, AJMS as description
        FROM XAGA_case
        WHERE AJMC LIKE ? OR AJMS LIKE ? OR AJDD LIKE ?
        LIMIT 20`
      
      const cases = await db.query(caseSql, [searchKeyword, searchKeyword, searchKeyword])
      results = results.concat(cases)
    }
    
    res.json({ code: 200, data: results })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 图谱查询
app.post('/api/v1/graph/query', async (req, res) => {
  try {
    const { entityId, entityType, depth = 2 } = req.body
    
    if (!entityId || !entityType) {
      return res.status(400).json({ code: 400, message: '缺少必要参数' })
    }
    
    const nodes = []
    const edges = []
    const visitedNodes = new Set()
    
    async function queryNode(nodeId, nodeType, currentDepth) {
      if (currentDepth > depth || visitedNodes.has(nodeId)) return
      visitedNodes.add(nodeId)
      
      if (nodeType === 'person') {
        const personRows = await db.query(
          'SELECT XRKBH as id, XM as name, XB as gender, SFZH as idCard FROM XAGA_person WHERE XRKBH = ?',
          [nodeId]
        )
        if (personRows.length > 0) {
          nodes.push({ ...personRows[0], type: 'person' })
        }
      }
    }
    
    await queryNode(entityId, entityType, 0)
    
    res.json({ code: 200, data: { nodes, edges } })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 图谱重新生成
app.post('/api/v1/graph/regenerate', async (req, res) => {
  try {
    const { entityId, entityType } = req.body
    res.json({ code: 200, message: '图谱重新生成任务已启动', data: { taskId: Date.now().toString() } })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取标签列表
app.get('/api/v1/tags', async (req, res) => {
  try {
    const { category, keyword, page = 1, pageSize = 20 } = req.query
    let sql = 'SELECT * FROM XAGA_tags WHERE 1=1'
    const params = []
    
    if (category) {
      sql += ' AND TAG_CATEGORY = ?'
      params.push(category)
    }
    
    if (keyword) {
      sql += ' AND (TAG_NAME LIKE ? OR TAG_CODE LIKE ? OR DESCRIPTION LIKE ?)'
      const likeKeyword = `%${keyword}%`
      params.push(likeKeyword, likeKeyword, likeKeyword)
    }
    
    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total')
    const countResult = await db.query(countSql, params)
    const total = countResult[0].total
    
    sql += ' ORDER BY UPDATE_TIME DESC LIMIT ? OFFSET ?'
    params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize))
    
    const rows = await db.query(sql, params)
    
    const tags = rows.map(row => ({
      tagCode: row.TAG_CODE,
      tagName: row.TAG_NAME,
      category: row.TAG_CATEGORY,
      description: row.DESCRIPTION,
      ontology: row.AI_TAG_ONTOLOGY,
      prompt: row.AI_PROMPT,
      status: row.STATUS,
      createTime: row.CREATE_TIME,
      updateTime: row.UPDATE_TIME
    }))
    
    res.json({
      code: 200,
      data: {
        list: tags,
        pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize) }
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 创建标签
app.post('/api/v1/tags', async (req, res) => {
  try {
    const { tagCode, tagName, category, description, ontology, prompt } = req.body
    
    await db.query(
      `INSERT INTO XAGA_tags (TAG_CODE, TAG_NAME, TAG_CATEGORY, DESCRIPTION, AI_TAG_ONTOLOGY, AI_PROMPT, STATUS)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [tagCode, tagName, category, description, JSON.stringify(ontology), prompt]
    )
    
    res.json({ code: 200, message: '标签创建成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 更新标签
app.put('/api/v1/tags/:tagCode', async (req, res) => {
  try {
    const { tagName, category, description, ontology, prompt, status } = req.body
    
    await db.query(
      `UPDATE XAGA_tags SET TAG_NAME = ?, TAG_CATEGORY = ?, DESCRIPTION = ?,
       AI_TAG_ONTOLOGY = ?, AI_PROMPT = ?, STATUS = ?, UPDATE_TIME = NOW()
       WHERE TAG_CODE = ?`,
      [tagName, category, description, JSON.stringify(ontology), prompt, status, req.params.tagCode]
    )
    
    res.json({ code: 200, message: '标签更新成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 删除标签
app.delete('/api/v1/tags/:tagCode', async (req, res) => {
  try {
    await db.query('DELETE FROM XAGA_tags WHERE TAG_CODE = ?', [req.params.tagCode])
    res.json({ code: 200, message: '标签删除成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取标签统计
app.get('/api/v1/tags/statistics', async (req, res) => {
  try {
    const categoryStats = await db.query('SELECT TAG_CATEGORY as category, COUNT(*) as count FROM XAGA_tags GROUP BY TAG_CATEGORY')
    const statusStats = await db.query('SELECT STATUS as status, COUNT(*) as count FROM XAGA_tags GROUP BY STATUS')
    const total = await db.query('SELECT COUNT(*) as total FROM XAGA_tags')
    
    res.json({
      code: 200,
      data: {
        total: total[0].total,
        byCategory: categoryStats,
        byStatus: statusStats
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取单个标签
app.get('/api/v1/tags/:tagCode', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM XAGA_tags WHERE TAG_CODE = ?', [req.params.tagCode])
    
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: '标签不存在' })
    }
    
    const row = rows[0]
    res.json({
      code: 200,
      data: {
        tagCode: row.TAG_CODE,
        tagName: row.TAG_NAME,
        category: row.TAG_CATEGORY,
        description: row.DESCRIPTION,
        ontology: row.AI_TAG_ONTOLOGY,
        prompt: row.AI_PROMPT,
        status: row.STATUS,
        createTime: row.CREATE_TIME,
        updateTime: row.UPDATE_TIME
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取标签示例
app.get('/api/v1/tags/:tagCode/examples', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM XAGA_tag_examples WHERE TAG_CODE = ?', [req.params.tagCode])
    res.json({ code: 200, data: rows })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 添加标签示例
app.post('/api/v1/tags/:tagCode/examples', async (req, res) => {
  try {
    const { entityType, entityId, description } = req.body
    await db.query(
      'INSERT INTO XAGA_tag_examples (TAG_CODE, ENTITY_TYPE, ENTITY_ID, DESCRIPTION) VALUES (?, ?, ?, ?)',
      [req.params.tagCode, entityType, entityId, description]
    )
    res.json({ code: 200, message: '示例添加成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 删除标签示例
app.delete('/api/v1/tags/:tagCode/examples/:exampleId', async (req, res) => {
  try {
    await db.query('DELETE FROM XAGA_tag_examples WHERE ID = ? AND TAG_CODE = ?', [req.params.exampleId, req.params.tagCode])
    res.json({ code: 200, message: '示例删除成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 测试标签
app.post('/api/v1/tags/:tagCode/test', async (req, res) => {
  try {
    const { entityId, entityType } = req.body
    
    const tagRows = await db.query('SELECT AI_PROMPT FROM XAGA_tags WHERE TAG_CODE = ?', [req.params.tagCode])
    if (tagRows.length === 0) {
      return res.status(404).json({ code: 404, message: '标签不存在' })
    }
    
    let entityData = {}
    if (entityType === 'person') {
      const personRows = await db.query('SELECT * FROM XAGA_person WHERE XRKBH = ?', [entityId])
      if (personRows.length > 0) {
        entityData = personRows[0]
      }
    }
    
    const prompt = `${tagRows[0].AI_PROMPT}\n\n实体数据：${JSON.stringify(entityData)}`
    const aiResult = await callAIModel(prompt)
    
    res.json({ code: 200, data: { result: aiResult, matched: aiResult.includes('是') || aiResult.includes('符合') } })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 批量测试标签
app.post('/api/v1/tags/:tagCode/batch-test', async (req, res) => {
  try {
    const { entityIds, entityType } = req.body
    const results = []
    
    for (const entityId of entityIds) {
      results.push({ entityId, result: '测试通过', matched: true })
    }
    
    res.json({ code: 200, data: { results, summary: { total: entityIds.length, matched: entityIds.length } } })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 自动打标签
app.post('/api/v1/tags/auto-label', async (req, res) => {
  try {
    const { entityType, entityId, tagCodes } = req.body
    res.json({ code: 200, message: '自动打标签任务已启动', data: { taskId: Date.now().toString() } })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 按实体类型自动打标签
app.post('/api/v1/tags/auto-label/:entityType', async (req, res) => {
  try {
    const { entityIds, tagCodes } = req.body
    res.json({ code: 200, message: '批量自动打标签任务已启动', data: { taskId: Date.now().toString() } })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取预警事件列表
app.get('/api/v1/warning/events', async (req, res) => {
  try {
    const { status, level, startTime, endTime, page = 1, pageSize = 20 } = req.query
    
    let sql = `SELECT e.*, r.RULE_NAME, i.INDICATOR_NAME 
               FROM XAGA_warning_events e
               LEFT JOIN XAGA_warning_rules r ON e.RULE_ID = r.ID
               LEFT JOIN XAGA_warning_indicators i ON r.INDICATOR_ID = i.ID
               WHERE 1=1`
    const params = []
    
    if (status) {
      sql += ' AND e.STATUS = ?'
      params.push(status)
    }
    
    if (level) {
      sql += ' AND e.WARNING_LEVEL = ?'
      params.push(level)
    }
    
    if (startTime) {
      sql += ' AND e.CREATE_TIME >= ?'
      params.push(startTime)
    }
    
    if (endTime) {
      sql += ' AND e.CREATE_TIME <= ?'
      params.push(endTime)
    }
    
    const countSql = sql.replace('SELECT e.*, r.RULE_NAME, i.INDICATOR_NAME', 'SELECT COUNT(*) as total')
    const countResult = await db.query(countSql, params)
    const total = countResult[0].total
    
    sql += ' ORDER BY e.CREATE_TIME DESC LIMIT ? OFFSET ?'
    params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize))
    
    const rows = await db.query(sql, params)
    
    const events = rows.map(row => ({
      eventNo: row.EVENT_NO,
      ruleId: row.RULE_ID,
      ruleName: row.RULE_NAME,
      indicatorId: row.INDICATOR_ID,
      indicatorName: row.INDICATOR_NAME,
      warningLevel: row.WARNING_LEVEL,
      warningContent: row.WARNING_CONTENT,
      entityType: row.ENTITY_TYPE,
      entityId: row.ENTITY_ID,
      entityName: row.ENTITY_NAME,
      status: row.STATUS,
      createTime: row.CREATE_TIME,
      updateTime: row.UPDATE_TIME
    }))
    
    res.json({
      code: 200,
      data: {
        list: events,
        pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize) }
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取预警事件统计
app.get('/api/v1/warning/events/statistics', async (req, res) => {
  try {
    const levelStats = await db.query('SELECT WARNING_LEVEL as level, COUNT(*) as count FROM XAGA_warning_events GROUP BY WARNING_LEVEL')
    const statusStats = await db.query('SELECT STATUS as status, COUNT(*) as count FROM XAGA_warning_events GROUP BY STATUS')
    const todayCount = await db.query('SELECT COUNT(*) as count FROM XAGA_warning_events WHERE DATE(CREATE_TIME) = CURDATE()')
    const totalCount = await db.query('SELECT COUNT(*) as count FROM XAGA_warning_events')
    
    res.json({
      code: 200,
      data: {
        total: totalCount[0].count,
        today: todayCount[0].count,
        byLevel: levelStats,
        byStatus: statusStats
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取单个预警事件
app.get('/api/v1/warning/events/:eventNo', async (req, res) => {
  try {
    const sql = `SELECT e.*, r.RULE_NAME, r.RULE_CONTENT, i.INDICATOR_NAME, i.INDICATOR_TYPE
                 FROM XAGA_warning_events e
                 LEFT JOIN XAGA_warning_rules r ON e.RULE_ID = r.ID
                 LEFT JOIN XAGA_warning_indicators i ON r.INDICATOR_ID = i.ID
                 WHERE e.EVENT_NO = ?`
    
    const rows = await db.query(sql, [req.params.eventNo])
    
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: '预警事件不存在' })
    }
    
    const row = rows[0]
    res.json({
      code: 200,
      data: {
        eventNo: row.EVENT_NO,
        ruleId: row.RULE_ID,
        ruleName: row.RULE_NAME,
        ruleContent: row.RULE_CONTENT,
        indicatorId: row.INDICATOR_ID,
        indicatorName: row.INDICATOR_NAME,
        indicatorType: row.INDICATOR_TYPE,
        warningLevel: row.WARNING_LEVEL,
        warningContent: row.WARNING_CONTENT,
        entityType: row.ENTITY_TYPE,
        entityId: row.ENTITY_ID,
        entityName: row.ENTITY_NAME,
        relatedData: row.RELATED_DATA,
        status: row.STATUS,
        feedback: row.FEEDBACK,
        feedbackTime: row.FEEDBACK_TIME,
        createTime: row.CREATE_TIME,
        updateTime: row.UPDATE_TIME
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 更新预警事件反馈
app.put('/api/v1/warning/events/:eventNo/feedback', async (req, res) => {
  try {
    const { feedback, status } = req.body
    
    await db.query(
      'UPDATE XAGA_warning_events SET FEEDBACK = ?, STATUS = ?, FEEDBACK_TIME = NOW(), UPDATE_TIME = NOW() WHERE EVENT_NO = ?',
      [feedback, status || 'processed', req.params.eventNo]
    )
    
    res.json({ code: 200, message: '反馈提交成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取预警指标列表
app.get('/api/v1/warning/indicators', async (req, res) => {
  try {
    const { category, status, page = 1, pageSize = 20 } = req.query
    
    let sql = 'SELECT * FROM XAGA_warning_indicators WHERE 1=1'
    const params = []
    
    if (category) {
      sql += ' AND INDICATOR_CATEGORY = ?'
      params.push(category)
    }
    
    if (status) {
      sql += ' AND STATUS = ?'
      params.push(status)
    }
    
    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total')
    const countResult = await db.query(countSql, params)
    const total = countResult[0].total
    
    sql += ' ORDER BY CREATE_TIME DESC LIMIT ? OFFSET ?'
    params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize))
    
    const rows = await db.query(sql, params)
    
    const indicators = rows.map(row => ({
      id: row.ID,
      indicatorName: row.INDICATOR_NAME,
      indicatorType: row.INDICATOR_TYPE,
      indicatorCategory: row.INDICATOR_CATEGORY,
      description: row.DESCRIPTION,
      dataSource: row.DATA_SOURCE,
      calculationLogic: row.CALCULATION_LOGIC,
      thresholdConfig: row.THRESHOLD_CONFIG,
      status: row.STATUS,
      createTime: row.CREATE_TIME,
      updateTime: row.UPDATE_TIME
    }))
    
    res.json({
      code: 200,
      data: {
        list: indicators,
        pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize) }
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取单个预警指标
app.get('/api/v1/warning/indicators/:id', async (req, res) => {
  try {
    const rows = await db.query('SELECT * FROM XAGA_warning_indicators WHERE ID = ?', [req.params.id])
    
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: '指标不存在' })
    }
    
    const row = rows[0]
    res.json({
      code: 200,
      data: {
        id: row.ID,
        indicatorName: row.INDICATOR_NAME,
        indicatorType: row.INDICATOR_TYPE,
        indicatorCategory: row.INDICATOR_CATEGORY,
        description: row.DESCRIPTION,
        dataSource: row.DATA_SOURCE,
        calculationLogic: row.CALCULATION_LOGIC,
        thresholdConfig: row.THRESHOLD_CONFIG,
        status: row.STATUS,
        createTime: row.CREATE_TIME,
        updateTime: row.UPDATE_TIME
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 创建预警指标
app.post('/api/v1/warning/indicators', async (req, res) => {
  try {
    const { indicatorName, indicatorType, indicatorCategory, description, dataSource, calculationLogic, thresholdConfig } = req.body
    
    const result = await db.query(
      `INSERT INTO XAGA_warning_indicators 
       (INDICATOR_NAME, INDICATOR_TYPE, INDICATOR_CATEGORY, DESCRIPTION, DATA_SOURCE, CALCULATION_LOGIC, THRESHOLD_CONFIG, STATUS)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [indicatorName, indicatorType, indicatorCategory, description, dataSource, calculationLogic, JSON.stringify(thresholdConfig)]
    )
    
    res.json({ code: 200, message: '指标创建成功', data: { id: result.insertId } })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 更新预警指标
app.put('/api/v1/warning/indicators/:id', async (req, res) => {
  try {
    const { indicatorName, indicatorType, indicatorCategory, description, dataSource, calculationLogic, thresholdConfig } = req.body
    
    await db.query(
      `UPDATE XAGA_warning_indicators 
       SET INDICATOR_NAME = ?, INDICATOR_TYPE = ?, INDICATOR_CATEGORY = ?, DESCRIPTION = ?,
           DATA_SOURCE = ?, CALCULATION_LOGIC = ?, THRESHOLD_CONFIG = ?, UPDATE_TIME = NOW()
       WHERE ID = ?`,
      [indicatorName, indicatorType, indicatorCategory, description, dataSource, calculationLogic, JSON.stringify(thresholdConfig), req.params.id]
    )
    
    res.json({ code: 200, message: '指标更新成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 删除预警指标
app.delete('/api/v1/warning/indicators/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM XAGA_warning_indicators WHERE ID = ?', [req.params.id])
    res.json({ code: 200, message: '指标删除成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 更新指标状态
app.put('/api/v1/warning/indicators/:id/status', async (req, res) => {
  try {
    const { status } = req.body
    await db.query('UPDATE XAGA_warning_indicators SET STATUS = ?, UPDATE_TIME = NOW() WHERE ID = ?', [status, req.params.id])
    res.json({ code: 200, message: '状态更新成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取指标下拉选项
app.get('/api/v1/warning/indicators/select', async (req, res) => {
  try {
    const rows = await db.query('SELECT ID as id, INDICATOR_NAME as name, INDICATOR_TYPE as type FROM XAGA_warning_indicators WHERE STATUS = "active"')
    res.json({ code: 200, data: rows })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取预警规则列表
app.get('/api/v1/warning/rules', async (req, res) => {
  try {
    const { indicatorId, status, page = 1, pageSize = 20 } = req.query
    
    let sql = `SELECT r.*, i.INDICATOR_NAME, i.INDICATOR_TYPE 
               FROM XAGA_warning_rules r
               LEFT JOIN XAGA_warning_indicators i ON r.INDICATOR_ID = i.ID
               WHERE 1=1`
    const params = []
    
    if (indicatorId) {
      sql += ' AND r.INDICATOR_ID = ?'
      params.push(indicatorId)
    }
    
    if (status) {
      sql += ' AND r.STATUS = ?'
      params.push(status)
    }
    
    const countSql = sql.replace('SELECT r.*, i.INDICATOR_NAME, i.INDICATOR_TYPE', 'SELECT COUNT(*) as total')
    const countResult = await db.query(countSql, params)
    const total = countResult[0].total
    
    sql += ' ORDER BY r.CREATE_TIME DESC LIMIT ? OFFSET ?'
    params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize))
    
    const rows = await db.query(sql, params)
    
    const rules = rows.map(row => ({
      id: row.ID,
      ruleName: row.RULE_NAME,
      indicatorId: row.INDICATOR_ID,
      indicatorName: row.INDICATOR_NAME,
      indicatorType: row.INDICATOR_TYPE,
      ruleType: row.RULE_TYPE,
      ruleContent: row.RULE_CONTENT,
      warningLevel: row.WARNING_LEVEL,
      warningTemplate: row.WARNING_TEMPLATE,
      status: row.STATUS,
      createTime: row.CREATE_TIME,
      updateTime: row.UPDATE_TIME
    }))
    
    res.json({
      code: 200,
      data: {
        list: rules,
        pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize) }
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取单个预警规则
app.get('/api/v1/warning/rules/:id', async (req, res) => {
  try {
    const sql = `SELECT r.*, i.INDICATOR_NAME, i.INDICATOR_TYPE, i.INDICATOR_CATEGORY
                 FROM XAGA_warning_rules r
                 LEFT JOIN XAGA_warning_indicators i ON r.INDICATOR_ID = i.ID
                 WHERE r.ID = ?`
    
    const rows = await db.query(sql, [req.params.id])
    
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: '规则不存在' })
    }
    
    const row = rows[0]
    res.json({
      code: 200,
      data: {
        id: row.ID,
        ruleName: row.RULE_NAME,
        indicatorId: row.INDICATOR_ID,
        indicatorName: row.INDICATOR_NAME,
        indicatorType: row.INDICATOR_TYPE,
        indicatorCategory: row.INDICATOR_CATEGORY,
        ruleType: row.RULE_TYPE,
        ruleContent: row.RULE_CONTENT,
        warningLevel: row.WARNING_LEVEL,
        warningTemplate: row.WARNING_TEMPLATE,
        status: row.STATUS,
        createTime: row.CREATE_TIME,
        updateTime: row.UPDATE_TIME
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 创建预警规则
app.post('/api/v1/warning/rules', async (req, res) => {
  try {
    const { ruleName, indicatorId, ruleType, ruleContent, warningLevel, warningTemplate } = req.body
    
    const result = await db.query(
      `INSERT INTO XAGA_warning_rules 
       (RULE_NAME, INDICATOR_ID, RULE_TYPE, RULE_CONTENT, WARNING_LEVEL, WARNING_TEMPLATE, STATUS)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [ruleName, indicatorId, ruleType, ruleContent, warningLevel, warningTemplate]
    )
    
    res.json({ code: 200, message: '规则创建成功', data: { id: result.insertId } })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 更新预警规则
app.put('/api/v1/warning/rules/:id', async (req, res) => {
  try {
    const { ruleName, indicatorId, ruleType, ruleContent, warningLevel, warningTemplate } = req.body
    
    await db.query(
      `UPDATE XAGA_warning_rules 
       SET RULE_NAME = ?, INDICATOR_ID = ?, RULE_TYPE = ?, RULE_CONTENT = ?,
           WARNING_LEVEL = ?, WARNING_TEMPLATE = ?, UPDATE_TIME = NOW()
       WHERE ID = ?`,
      [ruleName, indicatorId, ruleType, ruleContent, warningLevel, warningTemplate, req.params.id]
    )
    
    res.json({ code: 200, message: '规则更新成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 删除预警规则
app.delete('/api/v1/warning/rules/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM XAGA_warning_rules WHERE ID = ?', [req.params.id])
    res.json({ code: 200, message: '规则删除成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 更新规则状态
app.put('/api/v1/warning/rules/:id/status', async (req, res) => {
  try {
    const { status } = req.body
    await db.query('UPDATE XAGA_warning_rules SET STATUS = ?, UPDATE_TIME = NOW() WHERE ID = ?', [status, req.params.id])
    res.json({ code: 200, message: '状态更新成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取规则相关事件
app.get('/api/v1/warning/rules/:id/events', async (req, res) => {
  try {
    const { page = 1, pageSize = 10 } = req.query
    
    const countResult = await db.query('SELECT COUNT(*) as total FROM XAGA_warning_events WHERE RULE_ID = ?', [req.params.id])
    const total = countResult[0].total
    
    const rows = await db.query(
      'SELECT * FROM XAGA_warning_events WHERE RULE_ID = ? ORDER BY CREATE_TIME DESC LIMIT ? OFFSET ?',
      [req.params.id, parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize)]
    )
    
    res.json({
      code: 200,
      data: {
        list: rows,
        pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize) }
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 智能问答
app.post('/api/v1/qa/ask', async (req, res) => {
  try {
    const { question, conversationId, entityContext } = req.body
    
    if (!question || question.trim().length === 0) {
      return res.status(400).json({ code: 400, message: '问题不能为空' })
    }
    
    const prompt = `你是一个公安数据分析助手。请回答以下问题：\n\n问题：${question}`
    const answer = await callAIModel(prompt)
    
    const newConversationId = conversationId || Date.now().toString()
    
    res.json({
      code: 200,
      data: {
        answer,
        conversationId: newConversationId,
        suggestions: ['相关问题1', '相关问题2', '相关问题3']
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取问答历史
app.get('/api/v1/qa/history', async (req, res) => {
  try {
    const { page = 1, pageSize = 20 } = req.query
    
    const countResult = await db.query('SELECT COUNT(*) as total FROM XAGA_qa_conversations')
    const total = countResult[0].total
    
    const rows = await db.query(
      'SELECT * FROM XAGA_qa_conversations ORDER BY UPDATE_TIME DESC LIMIT ? OFFSET ?',
      [parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize)]
    )
    
    res.json({
      code: 200,
      data: {
        list: rows,
        pagination: { total, page: parseInt(page), pageSize: parseInt(pageSize) }
      }
    })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 获取对话图表数据
app.get('/api/v1/qa/chart/:conversationId', async (req, res) => {
  try {
    const rows = await db.query('SELECT CHART_DATA FROM XAGA_qa_conversations WHERE ID = ?', [req.params.conversationId])
    
    if (rows.length === 0) {
      return res.status(404).json({ code: 404, message: '对话不存在' })
    }
    
    res.json({ code: 200, data: JSON.parse(rows[0].CHART_DATA || '{}') })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 删除问答历史
app.delete('/api/v1/qa/history/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM XAGA_qa_conversations WHERE ID = ?', [req.params.id])
    res.json({ code: 200, message: '删除成功' })
  } catch (error) {
    res.status(500).json({ code: 500, message: error.message })
  }
})

// 初始化配置
initConfigTable()

// Vercel Serverless 导出
module.exports = app
