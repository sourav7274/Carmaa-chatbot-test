import mongoose from 'mongoose';
const { Schema } = mongoose;

const TimeSlotSchema = new Schema({
  time: { type: String, required: true },
  maxLimit: { type: Number },
  bookingCount: { type: Number, default: 0 }
});

const BookingScheduleSchema = new Schema(
  {
    date: { type: String, required: true }, 
    timeSlots: [TimeSlotSchema],
    region:{type:mongoose.Types.ObjectId,ref:'city'},
    weeklyOff: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'employee' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'employee' }
  },
  {
    timestamps: true 
  }
);

export const AvailableSlots = mongoose.model('availableSlots', BookingScheduleSchema);
