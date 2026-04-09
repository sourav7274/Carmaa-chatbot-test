import mongoose from 'mongoose';
const { Schema } = mongoose;

const carMakerSchema = new Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  image: {
    type: String,
  },
  status: {
    type: String, enum: ['active', 'inactive', 'pending', 'deleted']
  },
  priority: {
    type: Number,
    required: true
  },
  created_by: {
    type: Schema.Types.ObjectId,
    ref: 'employee'
  }, updated_by: {
    type: Schema.Types.ObjectId,
    ref: 'employee'
  },
}, { timestamps: true });

export const CarMaker = mongoose.model("carMaker", carMakerSchema);
