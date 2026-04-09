import mongoose from 'mongoose';
const { Schema } = mongoose;

const carModelSchema = new Schema({
  carName: {
    type: String,
    required: true,
    trim: true,
  },
  carImage: {
    type: String,
  },
  carMaker: {
    type: Schema.Types.ObjectId,
    ref: 'carMaker'
  },
  carType: {
    type: String, enum: [
      'hatchback',
      'sedan',
      'luxury',
      'suv',
      'mini suv'
    ],
    required: true
  },
  status: {
    type: String, enum: ['active', 'inactive', 'pending', 'deleted']
  },
  priority: {
    type: String,
    required: true
  },
  carLength: {
    type: String, enum: ['small', 'medium', 'large'],
  },
  created_by: {
    type: Schema.Types.ObjectId,
    ref: 'employee'
  }, updated_by: {
    type: Schema.Types.ObjectId,
    ref: 'employee'
  },
}, { timestamps: true });

export const CarModel = mongoose.model("car", carModelSchema);
