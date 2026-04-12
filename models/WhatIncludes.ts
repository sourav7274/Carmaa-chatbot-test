const mongoose = require('mongoose');
const { Schema } = mongoose;

const whatIncludes = new Schema({
    title: String,
    status: {
        type: String,enum:['active','inactive','delete']
    },
    created_by: {
        type: Schema.Types.ObjectId,
        ref: 'employee'
    }, updated_by: {
        type: Schema.Types.ObjectId,
        ref: 'employee'
    },
}, { timestamps: true })



exports.WhatIncludes = mongoose.model("whatIncludes", whatIncludes)