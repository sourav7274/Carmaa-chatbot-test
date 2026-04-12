import mongoose from 'mongoose';
const { Schema } = mongoose;

const prerequisites = new Schema({
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

export const Prerequisites = mongoose.model("prerequisites", prerequisites)